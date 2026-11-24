// Datenquelle: Transitous (MOTIS-API, https://transitous.org)
// Liefert Verbindungen im einheitlichen Format (siehe providers/index.js).

import { STATIONS, stationByKey } from '../stations.js?v=20261124c';

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
    result.sort((a, b) => new Date(a.expectedDeparture) - new Date(b.expectedDeparture));
    return { connections: result };
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
