# Pendlerzug Stade – Hamburg

Kleine mobile WebApp, die die nächsten Züge (RE5, S5, S3) zwischen **Stade, Neugraben, Hamburg-Harburg und Hamburg Hbf** anzeigt –
mit geplanter und voraussichtlicher Abfahrt, Gleis, voraussichtlicher Ankunft am Ziel und hervorgehobenen Ausfällen.

## Datenquelle

- MVP: [Transitous](https://transitous.org) (MOTIS-API, Datenquellen siehe <https://transitous.org/sources/>), ohne API-Key.
- Mehrere Zielbahnhöfe gleichzeitig wählbar; je Ziel wird die Ankunftszeit (oder n.V.) angezeigt.
- Später: offizielle DB-API (DB API Marketplace „Timetables“). Dafür wird nur `src/providers/dbTimetables.js`
  umgesetzt; die Oberfläche bleibt unverändert (gemeinsames Format siehe `src/providers/index.js`).

## Aufbau

- `index.html`, `styles.css` – Oberfläche (reines HTML/CSS/JS, kein Build-Schritt)
- `src/app.js` – Formular, Standardwerte nach Tageszeit, Darstellung der Verbindungen
- `src/stations.js` – Bahnhöfe, Linien, Hinweise
- `src/providers/` – austauschbare Datenquellen

Lokal starten: `python3 -m http.server` im Projektordner, dann <http://localhost:8000> öffnen.

## Lizenz

MIT

## HVV-Störungsmeldungen (Server)

`server/server.js` (Node 20, ohne Abhängigkeiten) ruft die offiziellen Meldungen über die Geofox-GTI-Schnittstelle (`getAnnouncements`) ab, filtert sie auf RE5, S5 und S3 und stellt sie unter `/api/meldungen` bereit (3 Minuten Cache).
Die Anfrage ist fest, daher ist auch die HMAC-Signatur fest. Sie liegt nicht im Repository, sondern wird als Header `geofox-auth-signature` ergänzt – lokal über die Umgebungsvariable `GTI_SIGNATURE`.

Start: `GTI_USER=<Benutzer> GTI_SIGNATURE=<Signatur> node server/server.js` (Port 5000).
