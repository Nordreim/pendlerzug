import { STATIONS, LINES, stationByKey, lineHints } from './stations.js?v=20261125a';
import { getProvider } from './providers/index.js?v=20261125a';

const TZ = 'Europe/Berlin';
const RESULT_COUNT = 4;
const DEFAULT_LINES = ['RE5', 'S5'];
const provider = getProvider('transitous');

const $ = (id) => document.getElementById(id);
const els = {
  start: $('start'), dests: $('dests'), swap: $('swap'), offset: $('offset'),
  timeOut: $('timeOut'), lageBody: $('lageBody'), lageRefresh: $('lageRefresh'), lageMini: $('lageMini'), lageMeta: $('lageMeta'), lines: $('lines'), form: $('search'), submit: $('submit'),
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

  if (c.kind === 'transfer') return transferHtml(c, line, status, body);

  return `<article class="card conn${c.cancelled ? ' cancelled' : ''}" style="--c:${line?.color || '#14213d'}">
    <div class="conn-top">
      <span class="badge">${esc(c.line)}</span>
      <span class="direction">${esc(c.direction)}${c.trainNumber ? ` <span class="sub" style="color:var(--ink-3);font-weight:500">· ${esc(c.trainNumber)}</span>` : ''}</span>
      ${status}
    </div>
    ${body}
  </article>`;
}

function transferHtml(c, line1, status, body) {
  const tr = c.transfer;
  const line2 = LINES.find((l) => l.key === c.second.line);
  const labels = { ok: 'Anschluss wird erreicht', tight: 'Anschluss wird knapp', lost: 'Anschluss entfällt durch Verspätung' };
  const mins = tr.level === 'lost' ? 'unter 1 min' : `${tr.minutes} min`;
  const platform = tr.arrivalTrack && tr.departureTrack && tr.arrivalTrack !== tr.departureTrack
    ? ` · Gleis ${esc(tr.arrivalTrack)} → ${esc(tr.departureTrack)}` : '';
  const hub = esc(shortName(tr.stationName || 'Hamburg-Harburg')).replace('Harburg', 'HH-Harburg');
  const box = `<div class="umst ${tr.level}">
      <strong>Umsteigezeit in ${hub} ${mins}</strong>
      <span class="umst-sub">${labels[tr.level]}${platform}</span>
      <span class="umst-times tnum">${esc(c.line)} an ${t(tr.hubArrivalExpected || tr.hubArrivalPlanned) ?? '–'} · ${esc(c.second.line)} ab ${t(tr.hubDepartureExpected || tr.hubDeparturePlanned) ?? '–'}</span>
    </div>`;
  return `<article class="card conn transfer${tr.level === 'lost' ? ' lostconn' : ''}" style="--c:${line1?.color || '#14213d'}">
    <div class="conn-top">
      <span class="badge">${esc(c.line)}</span><span class="arrow" aria-hidden="true">→</span>
      <span class="badge" style="background:${line2?.color || '#14213d'}">${esc(c.second.line)}</span>
      <span class="direction">via ${hub.replace("HH-","")}</span>
      ${status}
    </div>
    ${body}
    ${box}
  </article>`;
}

function shortName(n) {
  return n.replace('Hamburg-', '').replace('Hamburg ', '');
}

// Lagebild für alle drei Linien, unabhängig von der Auswahl im Formular:
// Pünktlichkeit aus den Fahrplandaten (Transitous) und HVV-Meldungen (Geofox, über eigenen Server)
const STATUS_LINES = ['RE5', 'S5', 'S3'];
const STATUS_REFRESH_MS = 120000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const rawApi = window.__API_BASE__ || '__PORT_5000__';
const API_BASE = rawApi.startsWith('__PORT_') ? (LOCAL_HOSTS.has(location.hostname) ? 'http://localhost:5000' : null) : rawApi;

const REASONS = {
  ROADWORKS: 'Bauarbeiten', SERVICE_FAILURE: 'Betriebsstörung', ACCIDENT: 'Unfall', POLICE_REQUEST: 'Polizeieinsatz',
  FIRE_BRIGADE_SAFETY_CHECKS: 'Feuerwehreinsatz', VEHICLE_ON_THE_LINE: 'Fahrzeug im Gleis', ROUTE_BLOCKAGE: 'Streckensperrung',
  STAFF_ABSENCE: 'Personalausfall', SPECIAL_EVENT: 'Veranstaltung', DEMONSTRATION: 'Demonstration', BOMB_ALERT: 'Bombenentschärfung',
  CONGESTION: 'Stau', SLIPPERINESS: 'Glätte', ROAD_CLOSED: 'Straßensperrung', STATION_OVERRUN: 'Überfüllung',
};
const fmtDateTime = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const openLines = new Set();
let statusController = null;
let lastPunct = null;
let lastHvv = null;

function lineState(s) {
  if (!s) return { cls: 'plan', label: 'Fahrplandaten nicht verfügbar', detail: '' };
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

function rangeText(v) {
  const b = v.begin ? fmtDateTime.format(new Date(v.begin)) : null;
  const e = v.end ? fmtDateTime.format(new Date(v.end)) : null;
  if (b && e) return `${b} – ${e} Uhr`;
  if (b) return `ab ${b} Uhr`;
  if (e) return `bis ${e} Uhr`;
  return '';
}

function sectionText(sec) {
  const part = sec.from && sec.to && sec.from !== sec.to ? `${sec.from} – ${sec.to}` : sec.from || sec.to || 'gesamte Linie';
  const dir = sec.bothDirections ? 'beide Richtungen' : sec.direction ? `Richtung ${sec.direction}` : '';
  return dir ? `${part} (${dir})` : part;
}

const KIND_TAG = {
  stoerung: '<span class="tag bad">Störung</span>',
  aktuell: '<span class="tag late">Jetzt gültig</span>',
  angekuendigt: '<span class="tag plan">Angekündigt</span>',
  barrierefrei: '<span class="tag soft">Barrierefreiheit</span>',
};

function messageHtml(m) {
  const kind = KIND_TAG[m.kind] || KIND_TAG.angekuendigt;
  const reason = m.kind !== 'barrierefrei' && m.reason && REASONS[m.reason] ? `<span class="tag soft">${esc(REASONS[m.reason])}</span>` : '';
  const allSections = [...new Set(m.sections.map(sectionText))];
  const sections = allSections.slice(0, 4);
  const times = m.validities.map(rangeText).filter(Boolean);
  const links = m.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(' · ');
  return `<article class="msg ${esc(m.kind)}">
    <div class="msg-tags">${kind}${reason}</div>
    ${m.summary ? `<p class="msg-title">${esc(m.summary)}</p>` : ''}
    ${sections.length ? `<p class="msg-meta"><span>Abschnitt:</span> ${esc(sections.join('; '))}${allSections.length > 4 ? ' …' : ''}</p>` : ''}
    ${times.length ? `<p class="msg-meta"><span>Zeitraum:</span> ${esc(times.join('; '))}${m.moreValidities ? ` und ${m.moreValidities} weitere` : ''}</p>` : ''}
    ${m.description ? `<p class="msg-text">${esc(m.description)}</p>` : ''}
    ${links ? `<p class="msg-links">${links}</p>` : ''}
  </article>`;
}

function hvvSummary(route) {
  if (!route.length) return 'Keine HVV-Meldungen zur Strecke Stade – Hamburg';
  const n = (k) => route.filter((m) => m.kind === k).length;
  const parts = [];
  if (n('stoerung')) parts.push(`${n('stoerung')} Störung${n('stoerung') === 1 ? '' : 'en'}`);
  if (n('aktuell')) parts.push(`${n('aktuell')} jetzt gültig`);
  if (n('angekuendigt')) parts.push(`${n('angekuendigt')} angekündigt`);
  if (n('barrierefrei')) parts.push(`${n('barrierefrei')} Barrierefreiheit`);
  return `${route.length} HVV-Meldung${route.length === 1 ? '' : 'en'}: ${parts.join(', ')}`;
}

function renderStatus() {
  const punct = lastPunct?.lines ? Object.fromEntries(lastPunct.lines.map((s) => [s.line, s])) : {};
  const hvvOk = lastHvv && lastHvv.ok;
  const mini = [];
  const rows = STATUS_LINES.map((key) => {
    const line = LINES.find((l) => l.key === key);
    const st = lineState(punct[key]);
    const msgs = hvvOk ? lastHvv.lines[key] || [] : [];
    const route = msgs.filter((m) => m.onRoute);
    const other = msgs.filter((m) => !m.onRoute);
    const unplanned = route.filter((m) => m.kind === 'stoerung').length;
    const dotCls = unplanned ? 'bad' : st.cls;
    mini.push(`<span class="mini" style="--c:${line?.color}"><span class="badge">${esc(key)}</span><span class="dot ${dotCls}"></span></span>`);
    const hvvLine = !lastHvv ? 'HVV-Meldungen werden geladen …'
      : !hvvOk ? 'HVV-Meldungen gerade nicht verfügbar'
      : hvvSummary(route);
    const otherHtml = other.length
      ? `<details class="others"><summary>Weitere Meldungen auf anderen Abschnitten (${other.length})</summary>${other.map(messageHtml).join('')}</details>` : '';
    const list = hvvOk
      ? (route.length ? route.map(messageHtml).join('') : '<p class="note">Zurzeit liegen beim HVV keine Meldungen zur Strecke Stade – Hamburg für diese Linie vor.</p>') + otherHtml
      : '<p class="note">Die HVV-Meldungen konnten gerade nicht geladen werden. Über den Link unten sind sie direkt beim HVV einsehbar.</p>';
    const count = hvvOk && route.length ? `<span class="count${unplanned ? ' bad' : ''}" title="HVV-Meldungen zur Strecke">${route.length}</span>` : '';
    return `<details class="lage-line" data-line="${key}" style="--c:${line?.color || '#14213d'}"${openLines.has(key) ? ' open' : ''}>
      <summary class="lage-row">
        <span class="badge">${esc(key)}</span>
        <span class="lage-text"><span class="lage-label ${st.cls}">${esc(st.label)}</span>
          ${st.detail ? `<span class="lage-detail">${esc(st.detail)}</span>` : ''}
          <span class="lage-detail hvv${unplanned ? ' bad' : ''}">${esc(hvvLine)}</span></span>
        <span class="lage-end">${count}<span class="dot ${dotCls}" aria-hidden="true"></span></span>
      </summary>
      <div class="msgs">${list}</div>
    </details>`;
  }).join('');
  els.lageBody.innerHTML = rows;
  els.lageMini.innerHTML = mini.join('');
  els.lageBody.querySelectorAll('details.lage-line').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) openLines.add(d.dataset.line); else openLines.delete(d.dataset.line);
  }));
  const parts = [`Pünktlichkeit: nächste 90 min ab Hamburg-Harburg, verspätet ab +5 min`];
  if (hvvOk) parts.push(`Meldungen: HVV (Geofox)${lastHvv.stale ? ', zuletzt bekannter Stand' : ''}`);
  els.lageMeta.textContent = `${parts.join('. ')}. Stand ${fmtTime.format(new Date())} Uhr.`;
}

async function loadHvv(signal) {
  if (!API_BASE) throw new Error('Kein Server konfiguriert');
  const res = await fetch(`${API_BASE}/api/meldungen`, { signal, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadStatus() {
  statusController?.abort();
  const controller = (statusController = new AbortController());
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
  els.lageRefresh.disabled = true;
  const punctP = provider.getLineStatus
    ? provider.getLineStatus({ lines: STATUS_LINES, signal: controller.signal })
    : Promise.reject(new Error('nicht verfügbar'));
  const hvvP = loadHvv(controller.signal);
  const [punct, hvv] = await Promise.allSettled([punctP, hvvP]);
  clearTimeout(timer);
  if (statusController !== controller) return; // neuere Abfrage läuft
  if (controller.signal.aborted && !timedOut) return;
  if (punct.status === 'fulfilled') lastPunct = punct.value;
  else { console.error(punct.reason); lastPunct = lastPunct || { lines: null }; }
  if (hvv.status === 'fulfilled') lastHvv = hvv.value;
  else { console.warn('HVV-Meldungen:', hvv.reason?.message); if (!lastHvv?.ok) lastHvv = { ok: false }; }
  renderStatus();
  els.lageRefresh.disabled = false;
}

initForm();
validate();
els.lageRefresh.addEventListener('click', loadStatus);
loadStatus();
setInterval(() => { if (!document.hidden) loadStatus(); }, STATUS_REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStatus(); });
