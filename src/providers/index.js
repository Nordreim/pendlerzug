// Auswahl der Datenquelle.
// Jede Datenquelle stellt `searchConnections(query)` bereit und liefert
// Verbindungen in diesem Format:
// {
//   id, line, trainNumber, direction,
//   plannedDeparture, expectedDeparture,   // ISO-Zeitstempel
//   track, plannedTrack,
//   cancelled, realtime,
//   arrivals: [{                           // je gewähltem Zielbahnhof
//     stationKey, stationName,
//     plannedArrival, expectedArrival,     // null = n.V.
//     continuesVia, continuesAt, continuesWaitMin
//   }]
// }
// Abfrage: searchConnections({ startKey, destKeys, lines, time, count, signal, onlyReachingDestination })
// Für die spätere offizielle DB-API wird nur eine weitere Datei
// (z. B. dbTimetables.js) mit derselben Funktion ergänzt.

import { transitousProvider } from './transitous.js';
import { dbTimetablesProvider } from './dbTimetables.js';

const PROVIDERS = { transitous: transitousProvider, db: dbTimetablesProvider };

export function getProvider(id = 'transitous') {
  return PROVIDERS[id] || transitousProvider;
}
