// Feste Konfiguration der Bahnhöfe und Linien.
// `order` beschreibt die Reihenfolge entlang der Strecke Stade – Hamburg Hbf
// und wird genutzt, um die Fahrtrichtung zu bestimmen.

export const STATIONS = [
  {
    key: 'stade',
    name: 'Stade',
    order: 0,
    // Abfrage-IDs bei Transitous (DELFI-Datensatz), getrennt nach S-Bahn- und Regionalbahnsteigen
    transitous: { S: 'de-DELFI_de:03359:8000089', RE: 'de-DELFI_de:03359:8000089' },
    // Kern-IDs (ohne Präfix/Bahnsteig), unter denen der Bahnhof im Fahrtverlauf auftaucht
    codes: ['de:03359:8000089'],
    evaNr: '8000089',
  },
  {
    key: 'neugraben',
    name: 'Neugraben',
    order: 1,
    transitous: { S: 'de-DELFI_de:02000:41951', RE: 'de-DELFI_de:02000:41951' },
    codes: ['de:02000:41951'],
    evaNr: null, // für die spätere DB-API noch zu ergänzen
  },
  {
    key: 'harburg',
    name: 'Hamburg-Harburg',
    order: 2,
    transitous: { S: 'de-DELFI_de:02000:49950', RE: 'de-DELFI_de:02000:8000147' },
    codes: ['de:02000:8000147', 'de:02000:49950'],
    evaNr: '8000147',
  },
  {
    key: 'hbf',
    name: 'Hamburg Hbf',
    order: 3,
    transitous: { S: 'de-DELFI_de:02000:10950_G', RE: 'de-DELFI_de:02000:10950' },
    codes: ['de:02000:10950'],
    evaNr: '8002549',
  },
];

export const LINES = [
  { key: 'RE5', label: 'RE5', color: '#e30513' },
  { key: 'S5', label: 'S5', color: '#009ccc' },
  { key: 'S3', label: 'S3', color: '#7a3a8e' },
];

export const stationByKey = (key) => STATIONS.find((s) => s.key === key);

/** Bekannte Einschränkungen, die als Hinweis angezeigt werden. */
export function lineHints(startKey, destKey, lines) {
  const hints = [];
  const involves = (k) => startKey === k || destKey === k;
  if (lines.includes('S3') && involves('stade')) {
    hints.push('Die S3 fährt nicht bis Stade. Für diese Strecke werden keine S3-Verbindungen angezeigt.');
  }
  if (lines.includes('RE5') && involves('neugraben')) {
    hints.push('Der RE5 hält nicht in Neugraben. Für diese Strecke werden keine RE5-Verbindungen angezeigt.');
  }
  return hints;
}
