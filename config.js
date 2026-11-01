// NotenApp – Einstellungen
// Hier stehen KEINE Passwörter. Die Client-ID ist öffentlich und darf im Code stehen.

export const CONFIG = {
  // OAuth-Client-ID aus der Google Cloud Console (siehe docs/google-einrichtung.md).
  // Endet auf ".apps.googleusercontent.com".
  GOOGLE_CLIENT_ID: "460899870019-gu384qvscfu8hcv75rvmm4fn4pjccl0g.apps.googleusercontent.com",

  // Die beiden Drive-Ordner „Noten“. Jeder Unterordner ist ein Stück.
  NOTEN_ORDNER: [
    { id: "1x8tVwolO0y1TMN0oCD0Fid6dVHDAsOIk", name: "Noten 1" },
    { id: "1RRCxuh4ViIX06kJ63JLJKSNgS7sLm2eq", name: "Noten 2" },
  ],

  // Wer die Seite „Verwaltung“ sieht (Google-Adressen, klein geschrieben, @gmail.com statt @googlemail.com).
  // Speichern klappt nur, wer auch Schreibrechte im ersten Noten-Ordner hat.
  VERWALTUNG: [
    "darkweezer@gmail.com",
  ],

  // Hier merkt sich die App, welche Stücke gerade nicht gespielt werden (Datei wird automatisch angelegt).
  STATUS_DATEI: { folderId: "1x8tVwolO0y1TMN0oCD0Fid6dVHDAsOIk", fileName: "notenarchiv-aktive-stuecke.json" },
};
