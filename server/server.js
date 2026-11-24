// Kleiner Server für die HVV-Störungsmeldungen (Geofox GTI, Methode getAnnouncements).
// Er holt die Meldungen höchstens alle 3 Minuten, speichert sie zwischen und
// gibt sie, nach Linien sortiert, an die App weiter.
//
// Authentifizierung: Geofox verlangt eine HMAC-SHA1-Signatur über den Anfrageinhalt.
// Die App stellt immer dieselbe Anfrage (BODY), daher ist die Signatur fest.
// Sie wird nicht im Code gespeichert, sondern beim Betrieb über einen gesicherten
// Proxy als Header "geofox-auth-signature" ergänzt (Umgebungsvariablen siehe unten).
// Alternativ kann sie lokal über GTI_SIGNATURE gesetzt werden.

import http from 'node:http';

const PORT = Number(process.env.PORT || 5000);
const GTI_USER = process.env.GTI_USER || 'DirkWefer';
// WICHTIG: Bei Änderung dieses Textes muss die Signatur neu berechnet werden.
const BODY = '{"language":"de","version":63,"full":true}';
const LINES = ['RE5', 'S5', 'S3'];
const CACHE_MS = 3 * 60 * 1000;
const TIMEOUT_MS = 12000;

// Gesicherter Proxy (Perplexity): Basis-URL und Token aus Umgebungsvariablen
const PROXY_URL = process.env[process.env.GTI_PROXY_URL_VAR || 'CUSTOM_CRED_GTI_GEOFOX_DE_URL'] || '';
const PROXY_TOKEN = process.env[process.env.GTI_PROXY_TOKEN_VAR || 'CUSTOM_CRED_GTI_GEOFOX_DE_PROXY_AUTH_KEY'] || '';

let cache = null; // { at, data }
let inflight = null;

function endpoint() {
  const base = PROXY_URL ? PROXY_URL.replace(/\/$/, '') : 'https://gti.geofox.de';
  return `${base}/gti/public/getAnnouncements`;
}

async function fetchAnnouncements() {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    Accept: 'application/json',
    'geofox-auth-type': 'HmacSHA1',
    'geofox-auth-user': GTI_USER,
    'X-Platform': 'web',
  };
  if (PROXY_TOKEN) headers['x-api-key'] = PROXY_TOKEN;
  if (process.env.GTI_SIGNATURE) headers['geofox-auth-signature'] = process.env.GTI_SIGNATURE;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint(), { method: 'POST', headers, body: BODY, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keine JSON-Antwort */ }
    if (!res.ok || !json || (json.returnCode && json.returnCode !== 'OK')) {
      const why = json?.errorText || json?.errorDevInfo || json?.returnCode || `HTTP ${res.status}`;
      throw new Error(`Geofox: ${why}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Geofox liefert Zeitpunkte z. B. als "2026-11-24T09:00:00.000+0100" oder als {date:"24.11.2026", time:"09:00"}.
// Die App bekommt einheitlich ISO-Zeitstempel (Safari kann "+0100" ohne Doppelpunkt nicht lesen).
function iso(v) {
  if (!v) return null;
  let d = null;
  if (typeof v === 'string') d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  else if (v.date) {
    const [dd, mm, yyyy] = v.date.split('.');
    d = new Date(`${yyyy}-${mm}-${dd}T${v.time || '00:00'}:00+01:00`);
  }
  return d && !isNaN(d) ? d.toISOString() : null;
}

// Bahnhöfe der Pendlerstrecke Stade – Hamburg Hbf (für die Einordnung „deine Strecke“)
const ROUTE_STATIONS = new Set([
  'stade', 'agathenburg', 'dollern', 'horneburg', 'neukloster', 'buxtehude', 'neu wulmstorf', 'fischbek',
  'neugraben', 'neuwiedenthal', 'heimfeld', 'harburg rathaus', 'harburg', 'wilhelmsburg', 'veddel',
  'hammerbrook', 'hbf', 'hauptbahnhof',
]);
const norm = (n) => (n || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/^hamburg[- ]/, '').replace(/\s+/g, ' ').trim();
const ACCESS_RE = /aufzug|fahrstuhl|rolltreppe|barrierefrei/i;

function classify(a, now) {
  const vals = (a.validities || []).map((v) => ({ begin: iso(v.begin), end: iso(v.end) }));
  const open = vals.filter((v) => !v.end || new Date(v.end).getTime() > now);
  if (vals.length && !open.length) return null; // abgelaufen
  const active = open.some((v) => !v.begin || new Date(v.begin).getTime() <= now);
  const text = `${a.summary || ''} ${a.description || ''}`;
  let kind;
  if (ACCESS_RE.test(text)) kind = 'barrierefrei';
  else if (!a.planned) kind = 'stoerung';
  else kind = active ? 'aktuell' : 'angekuendigt';
  return { kind, active, validities: open.slice(0, 3), moreValidities: Math.max(0, open.length - 3) };
}

const sdName = (sd) => (sd && (sd.name || sd.combinedName)) || null;

const KIND_ORDER = { stoerung: 0, aktuell: 1, angekuendigt: 2, barrierefrei: 3 };

function toLineGroups(json) {
  const now = Date.now();
  const groups = Object.fromEntries(LINES.map((l) => [l, []]));
  for (const a of json.announcements || []) {
    const perLine = new Map();
    for (const loc of a.locations || []) {
      const name = (loc.line?.name || '').trim().toUpperCase();
      if (!groups[name]) continue;
      const list = perLine.get(name) || [];
      list.push({
        from: sdName(loc.begin),
        to: sdName(loc.end),
        bothDirections: !!loc.bothDirections,
        direction: loc.line?.direction || null,
      });
      perLine.set(name, list);
    }
    if (!perLine.size) continue;
    const cls = classify(a, now);
    if (!cls) continue;
    for (const [line, sections] of perLine) {
      const onRoute = sections.some((x) => ROUTE_STATIONS.has(norm(x.from)) || ROUTE_STATIONS.has(norm(x.to)));
      groups[line].push({
        id: a.id,
        summary: a.summary || null,
        description: a.description || '',
        planned: !!a.planned,
        reason: a.reason || null,
        ...cls,
        onRoute,
        links: (a.links || []).filter((l) => /^https?:\/\//.test(l.url || '')).map((l) => ({ label: l.label || l.url, url: l.url })),
        sections,
        lastModified: iso(a.lastModified),
      });
    }
  }
  const firstBegin = (m) => (m.validities[0]?.begin ? new Date(m.validities[0].begin).getTime() : 0);
  for (const l of LINES) {
    groups[l].sort((x, y) => Number(y.onRoute) - Number(x.onRoute) || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || firstBegin(x) - firstBegin(y));
  }
  return groups;
}

const RETRY_MS = 60 * 1000; // nach einem Fehler höchstens einmal pro Minute neu bei Geofox anfragen
let lastFailAt = 0;
let lastError = null;

async function getData() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (inflight) return inflight;
  if (Date.now() - lastFailAt < RETRY_MS) {
    return cache ? { ...cache.data, stale: true } : { ok: false, error: lastError };
  }
  inflight = (async () => {
    try {
      const json = await fetchAnnouncements();
      const data = { ok: true, fetchedAt: new Date().toISOString(), lastUpdate: iso(json.lastUpdate), lines: toLineGroups(json) };
      cache = { at: Date.now(), data };
      return data;
    } catch (e) {
      console.error(new Date().toISOString(), e.message);
      lastFailAt = Date.now();
      lastError = 'Meldungen beim HVV gerade nicht abrufbar';
      // Bei Fehlern die letzten bekannten Meldungen weitergeben, falls vorhanden
      if (cache) return { ...cache.data, stale: true };
      return { ok: false, error: lastError };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(new Date().toISOString(), 'Handler-Fehler', e?.message);
    if (!res.headersSent) res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
    res.end('error');
  });
});

async function handle(req, res) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400, cors); return res.end('bad request'); }
  if (req.method === 'GET' && url.pathname.endsWith('/api/meldungen')) {
    const data = await getData();
    res.writeHead(data.ok ? 200 : 502, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(data));
  }
  if (url.pathname.endsWith('/api/health')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(404, cors);
  res.end('not found');
}

server.listen(PORT, () => console.log(`Meldungs-Server läuft auf Port ${PORT}`));
