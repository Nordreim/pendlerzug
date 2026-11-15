import { STATIONS, LINES, stationByKey, lineHints } from './stations.js';
import { getProvider } from './providers/index.js';

const TZ = 'Europe/Berlin';
const RESULT_COUNT = 4;
const DEFAULT_LINES = ['RE5', 'S5'];
const provider = getProvider('transitous');

const $ = (id) => document.getElementById(id);
const els = {
  start: $('start'), dest: $('dest'), swap: $('swap'), offset: $('offset'),
  timeOut: $('timeOut'), lines: $('lines'), form: $('search'), submit: $('submit'),
  error: $('formError'), onlyDest: $('onlyDest'), results: $('results'), clock: $('clock'),
};

const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const hourInBerlin = (d) => Number(new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d));
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
  els.dest.innerHTML = options;

  const morning = hourInBerlin(new Date()) < 12;
  els.start.value = morning ? 'stade' : 'hbf';
  els.dest.value = morning ? 'hbf' : 'stade';

  els.lines.innerHTML = LINES.map(
    (l) => `<label class="chip" style="--c:${l.color}">
      <input type="checkbox" name="lines" value="${l.key}" ${DEFAULT_LINES.includes(l.key) ? 'checked' : ''} />
      <span>${esc(l.label)}</span></label>`,
  ).join('');

  els.swap.addEventListener('click', () => {
    [els.start.value, els.dest.value] = [els.dest.value, els.start.value];
    validate();
  });
  els.offset.addEventListener('input', renderClock);
  [els.start, els.dest].forEach((el) => el.addEventListener('change', validate));
  els.lines.addEventListener('change', validate);
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (validate()) search();
  });

  renderClock();
  setInterval(renderClock, 15000);
}

function selectedLines() {
  return [...els.lines.querySelectorAll('input:checked')].map((i) => i.value);
}

function validate() {
  let msg = '';
  if (els.start.value === els.dest.value) msg = 'Start- und Zielbahnhof müssen unterschiedlich sein.';
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
  const destKey = els.dest.value;
  const lines = selectedLines();
  const time = selectedTime();
  const hints = lineHints(startKey, destKey, lines);

  els.submit.disabled = true;
  els.submit.textContent = 'Suche läuft …';
  els.results.innerHTML = head(startKey, destKey, time) + hintsHtml(hints) +
    '<div class="skeleton"></div>'.repeat(RESULT_COUNT);

  try {
    const { connections } = await provider.searchConnections({
      startKey, destKey, lines, time, count: RESULT_COUNT, signal: controller.signal,
      onlyReachingDestination: els.onlyDest.checked,
    });
    renderResults({ startKey, destKey, time, hints, connections });
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    els.results.innerHTML = head(startKey, destKey, time) + `<div class="card error">
      <strong>Die Fahrplandaten konnten gerade nicht geladen werden.</strong><br />
      ${esc(e.message)}<br /><button type="button" id="retry">Erneut versuchen</button></div>`;
    $('retry')?.addEventListener('click', search);
  } finally {
    els.submit.disabled = false;
    els.submit.textContent = 'Suchen';
  }
}

function head(startKey, destKey, time) {
  return `<div class="results-head">
    <h2>${esc(stationByKey(startKey).name)} → ${esc(stationByKey(destKey).name)}</h2>
    <span class="meta">ab ${fmtTime.format(time)} Uhr</span></div>`;
}

const hintsHtml = (hints) => hints.map((h) => `<p class="hint">${esc(h)}</p>`).join('');

function renderResults({ startKey, destKey, time, hints, connections }) {
  const destName = stationByKey(destKey).name;
  let html = head(startKey, destKey, time) + hintsHtml(hints);
  if (!connections.length) {
    html += `<div class="card empty">Keine passenden Verbindungen in den nächsten Stunden gefunden.</div>`;
  } else {
    html += connections.map((c) => connectionHtml(c, destName)).join('');
    if (connections.length < RESULT_COUNT) {
      html += `<p class="hint">In den nächsten rund 90 Minuten wurden nur ${connections.length} passende Verbindung${connections.length === 1 ? '' : 'en'} gefunden.</p>`;
    }
  }
  html += `<p class="note" style="padding:0 4px">Stand ${fmtTime.format(new Date())} Uhr. „Plandaten“ bedeutet: Für diesen Zug liegen keine Echtzeitdaten vor.</p>`;
  els.results.innerHTML = html;
}

function connectionHtml(c, destName) {
  const line = LINES.find((l) => l.key === c.line);
  const delay = c.plannedDeparture && c.expectedDeparture
    ? Math.round((new Date(c.expectedDeparture) - new Date(c.plannedDeparture)) / 60000) : 0;

  let status;
  if (c.cancelled) status = '<span class="status bad">Fällt aus</span>';
  else if (!c.realtime) status = '<span class="status plan">Plandaten</span>';
  else if (delay > 0) status = `<span class="status late">+${delay} min</span>`;
  else status = '<span class="status ok">pünktlich</span>';

  const arr = c.cancelled ? null : t(c.expectedArrival || c.plannedArrival);
  const arrDelay = c.plannedArrival && c.expectedArrival
    ? Math.round((new Date(c.expectedArrival) - new Date(c.plannedArrival)) / 60000) : 0;

  let note = '';
  if (c.continuesVia && !c.cancelled) {
    const wait = c.continuesWaitMin ?? 0;
    note = `<p class="note">Weiterfahrt ab ${esc(c.continuesVia)} um ${t(c.continuesAt)} Uhr${wait >= 5 ? ` (${wait} min Aufenthalt)` : ''}.</p>`;
  } else if (!arr && !c.cancelled) {
    note = `<p class="note">Dieser Zug fährt nicht bis ${esc(destName)}.</p>`;
  }

  return `<article class="card conn${c.cancelled ? ' cancelled' : ''}" style="--c:${line?.color || '#14213d'}">
    <div class="conn-top">
      <span class="badge">${esc(c.line)}</span>
      <span class="direction">${esc(c.direction)}${c.trainNumber ? ` <span class="sub" style="color:var(--ink-3);font-weight:500">· ${esc(c.trainNumber)}</span>` : ''}</span>
      ${status}
    </div>
    <div class="grid">
      <div class="cell"><span class="k">Geplant</span><span class="v tnum">${t(c.plannedDeparture) ?? '–'}</span></div>
      <div class="cell"><span class="k">Voraussichtl.</span><span class="v big tnum${delay > 0 && !c.cancelled ? ' late' : ''}">${t(c.expectedDeparture) ?? '–'}</span></div>
      <div class="cell"><span class="k">Gleis</span><span class="v tnum${c.track ? '' : ' muted'}">${esc(c.track) || '–'}</span></div>
      <div class="cell"><span class="k">An ${esc(shortName(destName))}</span>
        <span class="v tnum${arr ? (arrDelay > 0 ? ' late' : '') : ' muted'}">${arr ?? 'n.V.'}</span></div>
    </div>
    ${note}
  </article>`;
}

const shortName = (n) => n.replace('Hamburg-', '').replace('Hamburg ', '');

initForm();
validate();
