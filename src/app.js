import { STATIONS, LINES, stationByKey, lineHints } from './stations.js';
import { getProvider } from './providers/index.js';

const TZ = 'Europe/Berlin';
const RESULT_COUNT = 4;
const DEFAULT_LINES = ['RE5', 'S5'];
const provider = getProvider('transitous');

const $ = (id) => document.getElementById(id);
const els = {
  start: $('start'), dests: $('dests'), swap: $('swap'), offset: $('offset'),
  timeOut: $('timeOut'), lageBody: $('lageBody'), lageRefresh: $('lageRefresh'), lines: $('lines'), form: $('search'), submit: $('submit'),
  error: $('formError'), onlyDest: $('onlyDest'), results: $('results'), clock: $('clock'),
};

const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
const hourInBerlin = (d) => Number(hourFmt.formatToParts(d).find((p) => p.type === 'hour').value) % 24;
const t = (iso) => (iso ? fmtTime.format(new Date(iso)) : null);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function selectedTime() {
  const d = new Date(Date.now() + Number(els.offset.value) * 60000);
  d.setSeconds(0, 0);
  return d;
}

function renderClock() {
  els.clock.textContent = fmtTime.format(new Date());
  const off = Number(els.offset.value);
  els.timeOut.textContent = `${fmtTime.format(selectedTime())} Uhr${off ? ` (+${off} min)` : ''}`;
}

function initForm() {
  const options = STATIONS.map((s) => `<option value="${s.key}">${esc(s.name)}</option>`).join('');
  els.start.innerHTML = options;
  els.dests.innerHTML = STATIONS.map(
    (s) => `<label class="chip"><input type="checkbox" name="dests" value="${s.key}" /><span>${esc(s.name)}</span></label>`,
  ).join('');

  // 22–12 Uhr: Stade → Hamburg Hbf, 12–22 Uhr: Hamburg Hbf → Stade
  const hour = hourInBerlin(new Date());
  const toHamburg = hour >= 22 || hour < 12;
  els.start.value = toHamburg ? 'stade' : 'hbf';
  setDests([toHamburg ? 'hbf' : 'stade']);

  els.lines.innerHTML = LINES.map(
    (l) => `<label class="chip" style="--c:${l.color}">
      <input type="checkbox" name="lines" value="${l.key}" ${DEFAULT_LINES.includes(l.key) ? 'checked' : ''} />
      <span>${esc(l.label)}</span></label>`,
  ).join('');

  els.swap.addEventListener('click', () => {
    // Neuer Start: das am weitesten entfernte gewählte Ziel; neues Ziel: der bisherige Start
    const oldStart = els.start.value;
    const dests = selectedDests();
    if (!dests.length) return;
    const far = dests.reduce((best, k) =>
      Math.abs(stationByKey(k).order - stationByKey(oldStart).order) >
      Math.abs(stationByKey(best).order - stationByKey(oldStart).order) ? k : best);
    els.start.value = far;
    setDests([oldStart]);
    validate();
  });
  els.offset.addEventListener('input', renderClock);
  els.start.addEventListener('change', () => {
    syncDisabled();
    validate();
  });
  els.dests.addEventListener('change', validate);
  els.lines.addEventListener('change', validate);
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (validate()) search();
  });

  renderClock();
  setInterval(renderClock, 15000);
}

function setDests(keys) {
  els.dests.querySelectorAll('input').forEach((i) => (i.checked = keys.includes(i.value)));
  syncDisabled();
}

/** Der Startbahnhof kann nicht gleichzeitig Ziel sein. */
function syncDisabled() {
  els.dests.querySelectorAll('input').forEach((i) => {
    i.disabled = i.value === els.start.value;
    if (i.disabled) i.checked = false;
  });
}

/** Gewählte Ziele, sortiert nach Entfernung vom Start. */
function selectedDests() {
  const start = stationByKey(els.start.value);
  return [...els.dests.querySelectorAll('input:checked')]
    .map((i) => i.value)
    .sort((x, y) => Math.abs(stationByKey(x).order - start.order) - Math.abs(stationByKey(y).order - start.order));
}

function selectedLines() {
  return [...els.lines.querySelectorAll('input:checked')].map((i) => i.value);
}

function validate() {
  let msg = '';
  if (!selectedDests().length) msg = 'Bitte mindestens einen Zielbahnhof auswählen.';
  else if (!selectedLines().length) msg = 'Bitte mindestens eine Linie auswählen.';
  els.error.textContent = msg;
  els.error.hidden = !msg;
  return !msg;
}

let controller = null;

async function search() {
  controller?.abort();
  controller = new AbortController();
  const startKey = els.start.value;
  const destKeys = selectedDests();
  const lines = selectedLines();
  const time = selectedTime();
  const hints = [...new Set(destKeys.flatMap((d) => lineHints(startKey, d, lines)))];

  els.submit.disabled = true;
  els.submit.textContent = 'Suche läuft …';
  els.results.innerHTML = head(startKey, destKeys, time) + hintsHtml(hints) +
    '<div class="skeleton"></div>'.repeat(RESULT_COUNT);

  try {
    const { connections } = await provider.searchConnections({
      startKey, destKeys, lines, time, count: RESULT_COUNT, signal: controller.signal,
      onlyReachingDestination: els.onlyDest.checked,
    });
    renderResults({ startKey, destKeys, time, hints, connections });
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    els.results.innerHTML = head(startKey, destKeys, time) + `<div class="card error">
      <strong>Die Fahrplandaten konnten gerade nicht geladen werden.</strong><br />
      ${esc(e.message)}<br /><button type="button" id="retry">Erneut versuchen</button></div>`;
    $('retry')?.addEventListener('click', search);
  } finally {
    els.submit.disabled = false;
    els.submit.textContent = 'Suchen';
  }
}

function head(startKey, destKeys, time) {
  const names = destKeys.map((k) => (destKeys.length > 1 ? shortName(stationByKey(k).name) : stationByKey(k).name));
  return `<div class="results-head">
    <h2>${esc(stationByKey(startKey).name)} → ${esc(names.join(', '))}</h2>
    <span class="meta">ab ${fmtTime.format(time)} Uhr</span></div>`;
}

const hintsHtml = (hints) => hints.map((h) => `<p class="hint">${esc(h)}</p>`).join('');

function renderResults({ startKey, destKeys, time, hints, connections }) {
  let html = head(startKey, destKeys, time) + hintsHtml(hints);
  if (!connections.length) {
    html += `<div class="card empty">Keine passenden Verbindungen in den nächsten Stunden gefunden.</div>`;
  } else {
    html += connections.map((c) => connectionHtml(c)).join('');
    if (connections.length < RESULT_COUNT) {
      html += `<p class="hint">In den nächsten rund 90 Minuten wurden nur ${connections.length} passende Verbindung${connections.length === 1 ? '' : 'en'} gefunden.</p>`;
    }
  }
  html += `<p class="note" style="padding:0 4px">Stand ${fmtTime.format(new Date())} Uhr. „Plandaten“ bedeutet: Für diesen Zug liegen keine Echtzeitdaten vor.</p>`;
  els.results.innerHTML = html;
}

function arrivalInfo(c, ar) {
  const time = c.cancelled ? null : t(ar.expectedArrival);
  const late = ar.plannedArrival && ar.expectedArrival &&
    new Date(ar.expectedArrival) - new Date(ar.plannedArrival) >= 60000;
  let sub = '';
  if (ar.continuesVia && !c.cancelled) {
    const wait = ar.continuesWaitMin ?? 0;
    sub = `Weiterfahrt ab ${esc(ar.continuesVia)} um ${t(ar.continuesAt)} Uhr${wait >= 5 ? ` (${wait} min Aufenthalt)` : ''}`;
  } else if (!time && !c.cancelled) {
    sub = `Zug hält nicht in ${esc(ar.stationName)}`;
  }
  return { time, late, sub };
}

function connectionHtml(c) {
  const line = LINES.find((l) => l.key === c.line);
  const delay = c.plannedDeparture && c.expectedDeparture
    ? Math.round((new Date(c.expectedDeparture) - new Date(c.plannedDeparture)) / 60000) : 0;

  let status;
  if (c.cancelled) status = '<span class="status bad">Fällt aus</span>';
  else if (!c.realtime) status = '<span class="status plan">Plandaten</span>';
  else if (delay > 0) status = `<span class="status late">+${delay} min</span>`;
  else status = '<span class="status ok">pünktlich</span>';

  const depCells = `
      <div class="cell"><span class="k">Geplant</span><span class="v tnum">${t(c.plannedDeparture) ?? '–'}</span></div>
      <div class="cell"><span class="k">Voraussichtl.</span><span class="v big tnum${delay > 0 && !c.cancelled ? ' late' : ''}">${t(c.expectedDeparture) ?? '–'}</span></div>
      <div class="cell"><span class="k">Gleis</span><span class="v tnum${c.track ? '' : ' muted'}">${esc(c.track) || '–'}</span></div>`;

  let body;
  if (c.arrivals.length === 1) {
    const ar = c.arrivals[0];
    const info = arrivalInfo(c, ar);
    body = `<div class="grid">${depCells}
      <div class="cell"><span class="k">An ${esc(shortName(ar.stationName))}</span>
        <span class="v tnum${info.time ? (info.late ? ' late' : '') : ' muted'}">${info.time ?? 'n.V.'}</span></div>
    </div>${info.sub ? `<p class="note">${info.sub}.</p>` : ''}`;
  } else {
    const rows = c.arrivals.map((ar) => {
      const info = arrivalInfo(c, ar);
      return `<div class="row"><span class="k">An ${esc(ar.stationName)}${info.sub ? `<span class="sub">${info.sub}</span>` : ''}</span>
        <span class="v tnum${info.time ? (info.late ? ' late' : '') : ' muted'}">${info.time ?? 'n.V.'}</span></div>`;
    }).join('');
    body = `<div class="grid three">${depCells}</div><div class="arrivals">${rows}</div>`;
  }

  return `<article class="card conn${c.cancelled ? ' cancelled' : ''}" style="--c:${line?.color || '#14213d'}">
    <div class="conn-top">
      <span class="badge">${esc(c.line)}</span>
      <span class="direction">${esc(c.direction)}${c.trainNumber ? ` <span class="sub" style="color:var(--ink-3);font-weight:500">· ${esc(c.trainNumber)}</span>` : ''}</span>
      ${status}
    </div>
    ${body}
  </article>`;
}

function shortName(n) {
  return n.replace('Hamburg-', '').replace('Hamburg ', '');
}

// Lagebild für alle drei Linien, unabhängig von der Auswahl im Formular
const STATUS_LINES = ['RE5', 'S5', 'S3'];
const STATUS_REFRESH_MS = 120000;
let statusController = null;

function lineState(s) {
  if (!s.trips) return { cls: 'plan', label: 'keine Fahrten', detail: 'In den nächsten 90 Minuten sind keine Fahrten geplant.' };
  const parts = [];
  if (s.cancelled) parts.push(`${s.cancelled} Ausfall${s.cancelled === 1 ? '' : 'e'}`);
  if (s.delayed) parts.push(`${s.delayed} verspätet, bis +${s.maxDelay} min`);
  else if (s.maxDelay > 0) parts.push(`bis +${s.maxDelay} min`);
  const coverage = s.realtime + s.cancelled < s.trips
    ? `Echtzeit für ${s.realtime} von ${s.trips} Fahrten` : `${s.trips} Fahrt${s.trips === 1 ? '' : 'en'}`;
  if (s.cancelled || s.maxDelay >= 10) return { cls: 'bad', label: s.cancelled ? 'Ausfälle' : 'Große Verspätungen', detail: [...parts, coverage].join(' · ') };
  if (!s.realtime) return { cls: 'plan', label: 'keine Echtzeitdaten', detail: `${s.trips} Fahrt${s.trips === 1 ? '' : 'en'} laut Plan` };
  if (s.realtime * 2 < s.trips - s.cancelled) {
    return { cls: s.delayed ? 'late' : 'plan', label: s.delayed ? 'Verspätungen' : 'kaum Echtzeitdaten',
      detail: [...parts, `${coverage}${s.delayed ? '' : ', diese pünktlich'}`].join(' · ') };
  }
  if (s.delayed) return { cls: 'late', label: 'Verspätungen', detail: [...parts, coverage].join(' · ') };
  return { cls: 'ok', label: 'weitgehend pünktlich', detail: [...parts, coverage].join(' · ') };
}

async function loadStatus() {
  if (!provider.getLineStatus) return;
  statusController?.abort();
  statusController = new AbortController();
  els.lageRefresh.disabled = true;
  try {
    const res = await provider.getLineStatus({ lines: STATUS_LINES, signal: statusController.signal });
    const rows = res.lines.map((s) => {
      const line = LINES.find((l) => l.key === s.line);
      const st = lineState(s);
      const alerts = s.alerts.map((a) => `<p class="alert">${a.header ? `<strong>${esc(a.header)}</strong> ` : ''}${esc(a.text)}</p>`).join('');
      return `<div class="lage-row" style="--c:${line?.color || '#14213d'}">
        <span class="badge">${esc(s.line)}</span>
        <div class="lage-text"><span class="lage-label ${st.cls}">${esc(st.label)}</span>
          <span class="lage-detail">${esc(st.detail)}</span>${alerts}</div>
        <span class="dot ${st.cls}" aria-hidden="true"></span>
      </div>`;
    }).join('');
    els.lageBody.innerHTML = rows + `<p class="note lage-meta">Nächste ${res.windowMin} min ab ${esc(res.station)}, verspätet ab +${res.threshold} min. Stand ${fmtTime.format(new Date())} Uhr.</p>`;
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    els.lageBody.innerHTML = '<p class="note">Die Lage konnte gerade nicht geladen werden.</p>';
  } finally {
    els.lageRefresh.disabled = false;
  }
}

initForm();
validate();
els.lageRefresh.addEventListener('click', loadStatus);
loadStatus();
setInterval(() => { if (!document.hidden) loadStatus(); }, STATUS_REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStatus(); });
