// Datenquelle: Transitous (MOTIS-API, https://transitous.org)
// Liefert Verbindungen im einheitlichen Format (siehe providers/index.js).

import { STATIONS, stationByKey } from '../stations.js?v=20261126a';

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
const TRANSFER_MIN_WAIT_MIN = 3; // Mindest-Umsteigezeit
const MIN_LEAD_MIN = 18; // Hbf -> Stade: früheste RE5-Abfahrt in Harburg nach Startzeit
const MAX_TRANSFERS = 2;
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
  const stopTimes = (stopId, from) => getJson(`${BASE}/stoptimes?${new URLSearchParams({
    stopId, time: from.toISOString(), n: '100', radius: '0', exactRadius: 'true',
  })}`, signal).then((r) => r.stopTimes || []);
  const uniq = (list) => { const seen = new Set(); return list.filter((st) => !seen.has(st.tripId) && seen.add(st.tripId)); };
  const usable = (list, lines, fromMs) => uniq(list.filter((st) => (st.place?.departure || st.place?.scheduledDeparture)
    && lines.includes(lineOf(st)) && !isCancelled(st) && depMs(st) >= fromMs)).sort((a, b) => depMs(a) - depMs(b));
  const arrOf = (ev) => ms(ev.arrival || ev.scheduledArrival);
  const safeStops = async (tripId) => {
    try { return await tripStops(tripId, signal); } catch (e) { if (e.name === 'AbortError') throw e; return null; }
  };

  function build(fst, fstops, fev, cst, cstops, cev) {
    const lastF = fstops[fstops.length - 1];
    const lastC = cstops[cstops.length - 1];
    const fp = fst.place;
    const cp = cst.place;
    const minutes = Math.round((depMs(cst) - arrOf(fev)) / 60000);
    const planned = Math.round((depPlanMs(cst) - ms(fev.scheduledArrival || fev.arrival)) / 60000);
    return {
      id: `${fst.tripId}>${cst.tripId}`,
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
        minutes,
        plannedMinutes: planned,
        level: transferLevel(minutes),
        arrivalTrack: fev.track || null,
        departureTrack: cp.track || cp.scheduledTrack || null,
        hubArrivalPlanned: fev.scheduledArrival || null,
        hubArrivalExpected: fev.arrival || fev.scheduledArrival || null,
        hubDeparturePlanned: cp.scheduledDeparture || null,
        hubDepartureExpected: cp.departure || cp.scheduledDeparture || null,
      },
      second: { line: lineOf(cst), direction: lastC?.name || cst.headsign || '', realtime: !!cst.realTime },
      dest: {
        stationKey: dest.key,
        stationName: dest.name,
        plannedArrival: cev.scheduledArrival || null,
        expectedArrival: cev.arrival || cev.scheduledArrival || null,
      },
      connTripId: cst.tripId,
    };
  }

  const items = [];
  const minWait = TRANSFER_MIN_WAIT_MIN * 60000;

  if (start.key === 'hbf') {
    // 1A: nächste RE5 ab Harburg nach Stade, mindestens 18 min nach der Startzeit
    const [fAll, cAll] = await Promise.all([
      stopTimes(start.transitous.S, new Date(minTime)),
      stopTimes(hub.transitous.RE, new Date(minTime + MIN_LEAD_MIN * 60000)),
    ]);
    const feeders = usable(fAll, route.feederLines, minTime);
    const conns = usable(cAll, route.connLines, minTime + MIN_LEAD_MIN * 60000);
    const used = new Set();
    for (const cst of conns) {
      if (items.length >= MAX_TRANSFERS) break;
      const cstops = await safeStops(cst.tripId);
      if (!cstops) continue;
      const cev = evaluateTrip(cstops, hub, dest);
      if (!cev.relevant || cev.arrivalCancelled || !(cev.arrival || cev.scheduledArrival)) continue;
      // 1B: letzte S3/S5 ab Hbf, die mindestens 3 min vor der RE5-Abfahrt in Harburg ankommt
      const cand = feeders.filter((f) => depMs(f) <= depMs(cst) - 10 * 60000 && !used.has(f.tripId)).reverse().slice(0, 8);
      for (const fst of cand) {
        const fstops = await safeStops(fst.tripId);
        if (!fstops) continue;
        const fev = evaluateTrip(fstops, start, hub);
        if (!fev.relevant || fev.arrivalCancelled || !(fev.arrival || fev.scheduledArrival)) continue;
        if (depMs(cst) - arrOf(fev) < minWait) continue;
        used.add(fst.tripId);
        items.push(build(fst, fstops, fev, cst, cstops, cev));
        break;
      }
    }
  } else {
    // 2a: nächste RE5 ab Stade; 2b: endet sie in Harburg, nächste S3/S5 nach Hbf mit mindestens 3 min Umsteigezeit
    const [fAll, cAll] = await Promise.all([
      stopTimes(start.transitous.RE, new Date(minTime)),
      stopTimes(hub.transitous.S, new Date(minTime)),
    ]);
    const feeders = usable(fAll, route.feederLines, minTime).slice(0, 8);
    const conns = usable(cAll, route.connLines, minTime);
    for (const fst of feeders) {
      if (items.length >= MAX_TRANSFERS) break;
      const fstops = await safeStops(fst.tripId);
      if (!fstops) continue;
      const fev = evaluateTrip(fstops, start, hub);
      if (!fev.relevant || fev.arrivalCancelled || !(fev.arrival || fev.scheduledArrival)) continue;
      const through = evaluateTrip(fstops, start, dest);
      if (through.relevant && (through.arrival || through.scheduledArrival)) continue; // fährt durch bis Hbf
      for (const cst of conns.filter((c) => depMs(c) - arrOf(fev) >= minWait).slice(0, 6)) {
        const cstops = await safeStops(cst.tripId);
        if (!cstops) continue;
        const cev = evaluateTrip(cstops, hub, dest);
        if (!cev.relevant || cev.arrivalCancelled || !(cev.arrival || cev.scheduledArrival)) continue;
        items.push(build(fst, fstops, fev, cst, cstops, cev));
        break;
      }
    }
  }
  return items;
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
      const kept = transfers;
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
