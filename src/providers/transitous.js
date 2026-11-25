// Datenquelle: Transitous (MOTIS-API, https://transitous.org)
// Liefert Verbindungen im einheitlichen Format (siehe providers/index.js).

import { STATIONS, stationByKey } from '../stations.js?v=20261125a';

const BASE = 'https://api.transitous.org/api/v1';
const LOOKBACK_MIN = 40; // verspätete Züge mit früherer Planzeit mit erfassen
const MAX_CANDIDATES = 60;
const BATCH = 4;
const MAX_CONTINUATION_WAIT_MIN = 30;

// Kurzer Zwischenspeicher, damit gleiche Abfragen (z. B. bei mehreren Zielen)
// nicht mehrfach an Transitous gehen.
const CACHE_TTL_MS = 45000;
const cache = new Map();

async function getJson(url, signal) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = fetch(url, { signal, referrerPolicy: 'strict-origin-when-cross-origin' }).then((res) => {
    if (!res.ok) throw new Error(`Transitous antwortet mit HTTP ${res.status}`);
    return res.json();
  });
  cache.set(url, { at: Date.now(), promise });
  promise.catch(() => cache.delete(url));
  return promise;
}

/** "de-DELFI_de:02000:10950_G" -> "de:02000:10950" */
function coreCode(stopId = '') {
  const raw = stopId.replace(/^[a-z]{2}-[A-Za-z0-9]+_/, '');
  return raw.split(':').slice(0, 3).join(':').replace(/_G$/, '');
}

function stationOfStop(stopId) {
  const code = coreCode(stopId);
  return STATIONS.find((s) => s.codes.includes(code)) || null;
}

function lineOf(st) {
  const name = (st.routeShortName || st.displayName || '').trim();
  return name.split(/\s+/)[0].toUpperCase();
}

/** Alle Halte einer Fahrt in Reihenfolge. */
async function tripStops(tripId, signal) {
  const t = await getJson(`${BASE}/trip?tripId=${encodeURIComponent(tripId)}`, signal);
  const stops = [];
  for (const leg of t.legs || []) {
    for (const p of [leg.from, ...(leg.intermediateStops || []), leg.to]) {
      if (!p) continue;
      const last = stops[stops.length - 1];
      if (last && last.stopId === p.stopId) continue;
      stops.push(p);
    }
  }
  return stops;
}

/**
 * Wertet den Fahrtverlauf aus: fährt der Zug Richtung Ziel, und wann kommt er dort an?
 * Ergebnis: { relevant: boolean, arrival, scheduledArrival, arrivalCancelled }
 */
function evaluateTrip(stops, start, dest) {
  const startIdx = stops.findIndex((p) => stationOfStop(p.stopId)?.key === start.key);
  if (startIdx < 0) return { relevant: false };
  const dir = Math.sign(dest.order - start.order);
  for (let i = startIdx + 1; i < stops.length; i++) {
    const st = stationOfStop(stops[i].stopId);
    if (!st || st.key === start.key) continue;
    if (st.key === dest.key) {
      return {
        relevant: true,
        arrival: stops[i].arrival || null,
        scheduledArrival: stops[i].scheduledArrival || null,
        arrivalCancelled: !!stops[i].cancelled,
        track: stops[i].track || stops[i].scheduledTrack || null,
      };
    }
    // Erster Korridor-Bahnhof nach dem Start entscheidet über die Richtung
    if (Math.sign(st.order - start.order) !== dir) return { relevant: false };
    // Richtung stimmt, Ziel kommt evtl. noch – weitersuchen
  }
  // Richtung stimmte (oder kein weiterer Korridor-Bahnhof): Ziel wird nicht erreicht
  const anyForward = stops.slice(startIdx + 1).some((p) => {
    const st = stationOfStop(p.stopId);
    return st && Math.sign(st.order - start.order) === dir;
  });
  return anyForward ? { relevant: true, arrival: null, scheduledArrival: null } : { relevant: false };
}

/**
 * Manche Züge (z. B. S5 Hbf → Neugraben → Stade) sind in den Fahrplandaten
 * in zwei Fahrten geteilt. Endet eine Fahrt an einem Bahnhof vor dem Ziel,
 * wird die direkt anschließende Fahrt derselben Linie ab diesem Bahnhof gesucht.
 */
async function findContinuation(stops, line, start, dest, signal) {
  const last = stops[stops.length - 1];
  const endStation = last && stationOfStop(last.stopId);
  if (!endStation || endStation.key === dest.key) return null;
  const dir = Math.sign(dest.order - start.order);
  if (Math.sign(endStation.order - start.order) !== dir) return null;
  if (Math.sign(dest.order - endStation.order) !== dir) return null;
  const arr = new Date(last.arrival || last.scheduledArrival);
  if (Number.isNaN(arr.getTime())) return null;

  const type = line.startsWith('S') ? 'S' : 'RE';
  const params = new URLSearchParams({
    stopId: endStation.transitous[type],
    time: arr.toISOString(),
    n: '12',
    radius: '0',
    exactRadius: 'true',
  });
  const data = await getJson(`${BASE}/stoptimes?${params}`, signal);
  const options = (data.stopTimes || []).filter((st) => {
    if (lineOf(st) !== line) return false;
    if (stationOfStop(st.tripFrom?.stopId)?.key !== endStation.key) return false;
    const dep = new Date(st.place.departure || st.place.scheduledDeparture);
    const diff = (dep - arr) / 60000;
    return diff >= 0 && diff <= MAX_CONTINUATION_WAIT_MIN;
  });
  let next = null;
  let nextStops = null;
  let ev = null;
  for (const opt of options.slice(0, 3)) {
    const st = await tripStops(opt.tripId, signal);
    const e = evaluateTrip(st, endStation, dest);
    if (e.relevant && (e.arrival || e.scheduledArrival)) {
      next = opt;
      nextStops = st;
      ev = e;
      break;
    }
  }
  if (!next) return null;
  return {
    ...ev,
    via: endStation.name,
    viaDeparture: next.place.departure || next.place.scheduledDeparture,
    viaWaitMin: Math.round((new Date(next.place.departure || next.place.scheduledDeparture) - arr) / 60000),
    stops: nextStops,
  };
}


// ---------------------------------------------------------------------------
// Umsteigeverbindungen über Hamburg-Harburg (Stade <-> Hamburg Hbf).
// Zubringer und Anschluss kommen immer aus allen Linien, unabhängig von der Auswahl.

const TRANSFER_STATION = 'harburg';
const TRANSFER_OK_MIN = 3; // ab hier grün
const TRANSFER_MIN = 1; // darunter ist der Anschluss weg
const TRANSFER_MAX_WAIT_MIN = 45;
const FEEDER_WINDOW_MIN = 120;
const MAX_FEEDERS = 10;
const TRANSFER_ROUTES = {
  'hbf>stade': { feederLines: ['S3', 'S5'], connLines: ['RE5'], feederType: 'S', connType: 'RE' },
  'stade>hbf': { feederLines: ['RE5'], connLines: ['S3', 'S5'], feederType: 'RE', connType: 'S' },
};

const ms = (iso) => (iso ? new Date(iso).getTime() : NaN);
const isCancelled = (st) => !!(st.cancelled || st.tripCancelled || st.place?.cancelled);
const depMs = (st) => ms(st.place?.departure || st.place?.scheduledDeparture);
const depPlanMs = (st) => ms(st.place?.scheduledDeparture || st.place?.departure);

function transferLevel(minutes) {
  if (minutes >= TRANSFER_OK_MIN) return 'ok';
  if (minutes >= TRANSFER_MIN) return 'tight';
  return 'lost';
}

async function searchTransfers({ start, dest, time, signal }) {
  const route = TRANSFER_ROUTES[`${start.key}>${dest.key}`];
  if (!route) return [];
  const hub = stationByKey(TRANSFER_STATION);
  const minTime = Math.floor(time.getTime() / 60000) * 60000;
  const until = minTime + FEEDER_WINDOW_MIN * 60000;
  const stopTimes = (stopId, from) => getJson(`${BASE}/stoptimes?${new URLSearchParams({
    stopId, time: from.toISOString(), n: '100', radius: '0', exactRadius: 'true',
  })}`, signal).then((r) => r.stopTimes || []);

  const [fAll, cAll] = await Promise.all([
    stopTimes(start.transitous[route.feederType], new Date(time.getTime() - LOOKBACK_MIN * 60000)),
    stopTimes(hub.transitous[route.connType], new Date(time.getTime() - LOOKBACK_MIN * 60000)),
  ]);
  const uniq = (list) => { const seen = new Set(); return list.filter((st) => !seen.has(st.tripId) && seen.add(st.tripId)); };
  const hasDep = (st) => st.place?.departure || st.place?.scheduledDeparture;
  const feeders = uniq(fAll.filter(hasDep).filter((st) => route.feederLines.includes(lineOf(st)) && !isCancelled(st)
    && depMs(st) >= minTime && depMs(st) <= until)).sort((a, b) => depMs(a) - depMs(b)).slice(0, 30);
  const conns = uniq(cAll.filter(hasDep).filter((st) => route.connLines.includes(lineOf(st)) && !isCancelled(st)
    && depMs(st) >= minTime && depMs(st) <= until + (TRANSFER_MAX_WAIT_MIN + 60) * 60000)).sort((a, b) => depMs(a) - depMs(b));

  // Anschlusszüge werden erst bei Bedarf geprüft (Richtung, Ankunft am Ziel)
  const connMemo = new Map();
  const skipGroups = new Set();
  const gk = (st) => `${st.routeId}|${st.directionId}|${st.headsign}`;
  const evalConn = (st) => {
    if (!connMemo.has(st.tripId)) {
      connMemo.set(st.tripId, (async () => {
        try {
          const stops = await tripStops(st.tripId, signal);
          const ev = evaluateTrip(stops, hub, dest);
          if (!ev.relevant) { skipGroups.add(gk(st)); return null; }
          if (!(ev.arrival || ev.scheduledArrival) || ev.arrivalCancelled) return null;
          return { st, ev, stops };
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          return null;
        }
      })());
    }
    return connMemo.get(st.tripId);
  };

  async function pairFeeder(fst) {
    let fstops;
    try { fstops = await tripStops(fst.tripId, signal); } catch (e) { if (e.name === 'AbortError') throw e; return null; }
    const fev = evaluateTrip(fstops, start, hub);
    if (!fev.relevant) return 'wrong';
    if (fev.arrivalCancelled || !(fev.arrival || fev.scheduledArrival)) return null;
    const arrE = ms(fev.arrival || fev.scheduledArrival);
    const arrP = ms(fev.scheduledArrival || fev.arrival);
    let intended = null;
    let valid = null;
    for (const cst of conns) {
      const dE = depMs(cst);
      const dP = depPlanMs(cst);
      if (dE > arrE + TRANSFER_MAX_WAIT_MIN * 60000 && dP > arrP + TRANSFER_MAX_WAIT_MIN * 60000) break;
      const okE = dE - arrE >= TRANSFER_MIN * 60000 && dE - arrE <= TRANSFER_MAX_WAIT_MIN * 60000;
      const okP = dP - arrP >= TRANSFER_MIN * 60000;
      if (!okE && !(okP && !intended)) continue;
      if (skipGroups.has(gk(cst))) continue;
      const c = await evalConn(cst);
      if (!c) continue;
      if (okP && !intended) intended = c;
      if (okE) { valid = c; break; }
    }
    const c = valid || intended;
    if (!c) return null;
    const dE = depMs(c.st);
    const minutes = Math.round((dE - arrE) / 60000);
    const lost = !valid;
    const planned = Math.round((depPlanMs(c.st) - arrP) / 60000);
    const lastF = fstops[fstops.length - 1];
    const lastC = c.stops[c.stops.length - 1];
    const fp = fst.place;
    const cp = c.st.place;
    return {
      id: `${fst.tripId}>${c.st.tripId}`,
      kind: 'transfer',
      line: lineOf(fst),
      direction: lastF?.name || fst.headsign || '',
      plannedDeparture: fp.scheduledDeparture || null,
      expectedDeparture: fp.departure || fp.scheduledDeparture || null,
      track: fp.track || fp.scheduledTrack || null,
      plannedTrack: fp.scheduledTrack || null,
      cancelled: false,
      realtime: !!fst.realTime,
      transfer: {
        stationName: hub.name,
        minutes: lost ? Math.min(minutes, 0) : minutes,
        plannedMinutes: planned,
        level: lost ? 'lost' : transferLevel(minutes),
        arrivalTrack: fev.track || null,
        departureTrack: cp.track || cp.scheduledTrack || null,
        hubArrivalPlanned: fev.scheduledArrival || null,
        hubArrivalExpected: fev.arrival || fev.scheduledArrival || null,
        hubDeparturePlanned: cp.scheduledDeparture || null,
        hubDepartureExpected: cp.departure || cp.scheduledDeparture || null,
      },
      second: {
        line: lineOf(c.st),
        direction: lastC?.name || c.st.headsign || '',
        realtime: !!c.st.realTime,
      },
      dest: {
        stationKey: dest.key,
        stationName: dest.name,
        plannedArrival: c.ev.scheduledArrival || null,
        expectedArrival: lost ? null : c.ev.arrival || c.ev.scheduledArrival || null,
      },
      connTripId: c.st.tripId,
    };
  }

  // Fahrten mit Zubringern auswerten, bis genug relevante gefunden sind
  const items = [];
  const feederGroupsSkipped = new Set();
  let i = 0;
  while (i < feeders.length && items.length < MAX_FEEDERS) {
    const batch = [];
    while (i < feeders.length && batch.length < BATCH) {
      const st = feeders[i++];
      if (!feederGroupsSkipped.has(gk(st))) batch.push(st);
    }
    if (!batch.length) break;
    const out = await Promise.all(batch.map(async (st) => ({ st, item: await pairFeeder(st) })));
    for (const { st, item } of out) {
      if (item === 'wrong') feederGroupsSkipped.add(gk(st));
      else if (item) items.push(item);
    }
  }

  // Je Anschlusszug nur der späteste Zubringer (gültige Anschlüsse)
  const byConn = new Map();
  const lostItems = [];
  for (const it of items) {
    if (it.transfer.level === 'lost') { lostItems.push(it); continue; }
    const cur = byConn.get(it.connTripId);
    if (!cur || ms(it.expectedDeparture) > ms(cur.expectedDeparture)) byConn.set(it.connTripId, it);
  }
  return [...byConn.values(), ...lostItems];
}

export const transitousProvider = {
  id: 'transitous',
  label: 'Transitous',

  /**
   * @param {{startKey:string,destKeys:string[],lines:string[],time:Date,count?:number,
   *          signal?:AbortSignal,onlyReachingDestination?:boolean}} q
   * @returns {Promise<{connections: Array}>}
   */
  async searchConnections({ startKey, destKeys, lines, time, count = 4, signal, onlyReachingDestination = false }) {
    const start = stationByKey(startKey);
    const dests = destKeys.map(stationByKey).filter((d) => d && d.key !== start.key);
    const from = new Date(time.getTime() - LOOKBACK_MIN * 60000);
    const types = [...new Set(lines.map((l) => (l.startsWith('S') ? 'S' : 'RE')))];
    const stopIds = [...new Set(types.map((t) => start.transitous[t]))];

    const responses = await Promise.all(
      stopIds.map((stopId) => {
        const params = new URLSearchParams({
          stopId,
          time: from.toISOString(),
          n: '100',
          radius: '0',
          exactRadius: 'true',
        });
        return getJson(`${BASE}/stoptimes?${params}`, signal);
      }),
    );
    const minTime = Math.floor(time.getTime() / 60000) * 60000;
    const depOf = (st) => new Date(st.place.departure || st.place.scheduledDeparture).getTime();

    const seen = new Set();
    const candidates = responses
      .flatMap((r) => r.stopTimes || [])
      .filter((st) => st.place?.departure || st.place?.scheduledDeparture)
      .filter((st) => lines.includes(lineOf(st)))
      .filter((st) => depOf(st) >= minTime)
      .filter((st) => (seen.has(st.tripId) ? false : seen.add(st.tripId)))
      .sort((a, b) => depOf(a) - depOf(b))
      .slice(0, MAX_CANDIDATES);

    // Fahrten derselben Linie und Richtung (routeId + directionId) verhalten sich gleich.
    // Ist eine Gruppe als „falsche Richtung“ erkannt, werden weitere Fahrten nicht abgefragt.
    const groupKey = (st) => `${st.routeId}|${st.directionId}|${st.headsign}`;
    const skipGroups = new Set();

    async function evaluate(st) {
      let stops;
      try {
        stops = await tripStops(st.tripId, signal);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // Fahrtverlauf nicht abrufbar: anzeigen, Ankunft unbekannt
        return { st, stops: [], relevant: true, arrivals: dests.map((d) => ({ station: d })) };
      }
      const perDest = dests.map((d) => ({ station: d, ev: evaluateTrip(stops, start, d) }));
      const relevant = perDest.some((x) => x.ev.relevant);
      if (!relevant) return { st, stops, relevant };
      const arrivals = await Promise.all(
        perDest.map(async ({ station, ev }) => {
          if (ev.arrival || ev.scheduledArrival) {
            return { station, planned: ev.scheduledArrival, expected: ev.arrival, cancelled: !!ev.arrivalCancelled };
          }
          if (!ev.relevant) return { station };
          const cont = await findContinuation(stops, lineOf(st), start, station, signal).catch((e) => {
            if (e.name === 'AbortError') throw e;
            return null;
          });
          if (!cont) return { station };
          return {
            station,
            planned: cont.scheduledArrival,
            expected: cont.arrival,
            cancelled: !!cont.arrivalCancelled,
            via: cont.via,
            viaDeparture: cont.viaDeparture,
            viaWaitMin: cont.viaWaitMin,
          };
        }),
      );
      return { st, stops, relevant, arrivals };
    }

    const result = [];
    let i = 0;
    while (i < candidates.length && result.length < count) {
      const batch = [];
      while (i < candidates.length && batch.length < BATCH) {
        const st = candidates[i++];
        if (!skipGroups.has(groupKey(st))) batch.push(st);
      }
      if (!batch.length) break;
      const evaluated = await Promise.all(batch.map(evaluate));

      for (const { st, stops, relevant, arrivals } of evaluated) {
        if (!relevant) {
          skipGroups.add(groupKey(st));
          continue;
        }
        if (result.length >= count) continue;
        const reachesAny = arrivals.some((a) => a.planned || a.expected);
        if (onlyReachingDestination && !reachesAny) {
          // Endet die Fahrt nicht an einem unserer Bahnhöfe, ist keine Weiterfahrt möglich:
          // weitere Fahrten dieser Gruppe brauchen nicht abgefragt zu werden.
          if (!stationOfStop(stops[stops.length - 1]?.stopId)) skipGroups.add(groupKey(st));
          continue;
        }
        const p = st.place;
        const cancelled = !!(st.cancelled || st.tripCancelled || p.cancelled);
        const lastStop = stops[stops.length - 1];
        result.push({
          id: st.tripId,
          line: lineOf(st),
          trainNumber: (st.routeShortName || '').match(/\((\d+)\)/)?.[1] || null,
          direction: lastStop?.name || st.tripTo?.name || st.headsign || '',
          plannedDeparture: p.scheduledDeparture || null,
          expectedDeparture: p.departure || p.scheduledDeparture || null,
          track: p.track || p.scheduledTrack || null,
          plannedTrack: p.scheduledTrack || null,
          cancelled,
          realtime: !!st.realTime,
          arrivals: arrivals.map((a) => ({
            stationKey: a.station.key,
            stationName: a.station.name,
            plannedArrival: a.planned || null,
            expectedArrival: cancelled || a.cancelled ? null : a.expected || a.planned || null,
            continuesVia: a.via || null,
            continuesAt: a.viaDeparture || null,
            continuesWaitMin: a.viaWaitMin ?? null,
          })),
        });
      }
    }
    // Umsteigeverbindungen über Hamburg-Harburg ergänzen (Stade <-> Hamburg Hbf)
    let transfers = [];
    const transferDest = dests.find((d) => TRANSFER_ROUTES[`${start.key}>${d.key}`]);
    if (transferDest) {
      try {
        transfers = await searchTransfers({ start, dest: transferDest, time, signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.warn('Umsteigeverbindungen nicht verfügbar:', e);
      }
    }
    if (transfers.length) {
      const arrMs = (c) => {
        const a = c.arrivals.find((x) => x.stationKey === transferDest.key);
        return !c.cancelled && a ? ms(a.expectedArrival) : NaN;
      };
      const rivals = result.map((c) => ({ id: c.id, dep: ms(c.expectedDeparture), arr: arrMs(c) })).filter((r) => Number.isFinite(r.arr));
      const ownArr = (t) => ms(t.dest.expectedArrival);
      const live = transfers.filter((t) => t.transfer.level !== 'lost' && Number.isFinite(ownArr(t)));
      for (const t of live) rivals.push({ id: t.id, dep: ms(t.expectedDeparture), arr: ownArr(t), transfer: true });
      const kept = transfers.filter((t) => {
        if (t.transfer.level === 'lost') return true;
        const dep = ms(t.expectedDeparture);
        const arr = ownArr(t);
        // Ein Umstieg lohnt nur, wenn er mindestens 3 min früher ankommt als jede
        // gleich spät oder später abfahrende Alternative
        return !rivals.some((r) => r.id !== t.id && r.dep >= dep && r.arr <= arr + (r.transfer ? 0 : 3 * 60000)
          && (!r.transfer || r.dep > dep || r.arr < arr || r.id < t.id));
      });
      for (const t of kept) {
        const hubArr = { plannedArrival: t.transfer.hubArrivalPlanned, expectedArrival: t.transfer.hubArrivalExpected };
        result.push({
          ...t,
          arrivals: dests.map((d) => {
            if (d.key === t.dest.stationKey) return { stationKey: d.key, stationName: d.name, plannedArrival: t.dest.plannedArrival, expectedArrival: t.dest.expectedArrival };
            if (d.key === TRANSFER_STATION) return { stationKey: d.key, stationName: d.name, ...hubArr };
            return { stationKey: d.key, stationName: d.name, plannedArrival: null, expectedArrival: null };
          }),
        });
      }
    }
    result.sort((a, b) => new Date(a.expectedDeparture) - new Date(b.expectedDeparture));
    return { connections: result.slice(0, count) };
  },
};

// ---------------------------------------------------------------------------
// Lagebild: Pünktlichkeit und Ausfälle je Linie in den nächsten Minuten.
// Gemessen an Hamburg-Harburg, wo RE5, S5 und S3 in beiden Richtungen halten.

const STATUS_STATION = 'harburg';
const STATUS_WINDOW_MIN = 90;
const DELAY_THRESHOLD_MIN = 5;

function alertTexts(st) {
  const list = [...(st.place?.alerts || []), ...(st.alerts || [])];
  return list
    .map((a) => ({
      header: a.headerText || a.header || '',
      text: a.descriptionText || a.description || '',
    }))
    .filter((a) => a.header || a.text);
}

/**
 * @param {{lines:string[], signal?:AbortSignal}} q
 * @returns {Promise<{station:string, windowMin:number, lines:Array<{
 *   line:string, trips:number, realtime:number, cancelled:number, delayed:number,
 *   maxDelay:number, alerts:Array<{header:string,text:string}>}>}>}
 */
export async function getLineStatus({ lines, signal }) {
  const station = stationByKey(STATUS_STATION);
  const now = Date.now();
  const from = new Date(now - LOOKBACK_MIN * 60000);
  const until = now + STATUS_WINDOW_MIN * 60000;
  const stopIds = [...new Set([station.transitous.S, station.transitous.RE])];
  const responses = await Promise.all(
    stopIds.map((stopId) => {
      const params = new URLSearchParams({
        stopId, time: from.toISOString(), n: '150', radius: '0', exactRadius: 'true', withAlerts: 'true',
      });
      return getJson(`${BASE}/stoptimes?${params}`, signal);
    }),
  );

  const stats = new Map(lines.map((l) => [l, { line: l, trips: 0, realtime: 0, cancelled: 0, delayed: 0, maxDelay: 0, alerts: [] }]));
  const seen = new Set();
  for (const st of responses.flatMap((r) => r.stopTimes || [])) {
    const s = stats.get(lineOf(st));
    if (!s || seen.has(st.tripId)) continue;
    const p = st.place || {};
    const planned = p.scheduledDeparture || p.scheduledArrival;
    const expected = p.departure || p.arrival || planned;
    if (!planned) continue;
    const exp = new Date(expected).getTime();
    const plan = new Date(planned).getTime();
    // Fahrten, die noch bevorstehen und deren Planzeit im Zeitfenster liegt
    if (exp < now - 60000 || plan > until) continue;
    seen.add(st.tripId);
    s.trips++;
    for (const a of alertTexts(st)) {
      if (!s.alerts.some((x) => x.header === a.header && x.text === a.text)) s.alerts.push(a);
    }
    if (st.cancelled || st.tripCancelled || p.cancelled) {
      s.cancelled++;
      continue;
    }
    if (!st.realTime) continue;
    s.realtime++;
    const delay = Math.max(0, Math.round((exp - plan) / 60000));
    if (delay >= DELAY_THRESHOLD_MIN) s.delayed++;
    s.maxDelay = Math.max(s.maxDelay, delay);
  }
  return { station: station.name, windowMin: STATUS_WINDOW_MIN, threshold: DELAY_THRESHOLD_MIN, lines: [...stats.values()] };
}

transitousProvider.getLineStatus = getLineStatus;
