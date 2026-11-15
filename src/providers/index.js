// Auswahl der Datenquelle.
// Jede Datenquelle stellt `searchConnections(query)` bereit und liefert
// Verbindungen in diesem Format:
// {
//   id, line, trainNumber, direction,
//   plannedDeparture, expectedDeparture,   // ISO-Zeitstempel
//   track, plannedTrack,
//   plannedArrival, expectedArrival,       // am Zielbahnhof, null = n.V.
//   cancelled, realtime
// }
// Für die spätere offizielle DB-API wird nur eine weitere Datei
// (z. B. dbTimetables.js) mit derselben Funktion ergänzt.

import { transitousProvider } from './transitous.js';
import { dbTimetablesProvider } from './dbTimetables.js';

const PROVIDERS = { transitous: transitousProvider, db: dbTimetablesProvider };

export function getProvider(id = 'transitous') {
  return PROVIDERS[id] || transitousProvider;
}
