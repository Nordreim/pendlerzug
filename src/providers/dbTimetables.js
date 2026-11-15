// Platzhalter für die offizielle DB-API (DB API Marketplace, "Timetables").
// Diese API benötigt Client-ID und API-Key. Die Schlüssel dürfen nicht im
// Browser liegen, daher wird dafür ein kleiner Server (z. B. Supabase Edge
// Function) als Vermittler benötigt. Die Funktion muss dasselbe Format wie
// providers/transitous.js zurückgeben.

export const dbTimetablesProvider = {
  id: 'db',
  label: 'DB Timetables',
  async searchConnections() {
    throw new Error('Die DB-Schnittstelle ist noch nicht eingerichtet.');
  },
};
