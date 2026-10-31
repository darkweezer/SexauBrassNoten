// Notenarchiv – Einstellungen
// Hier stehen KEINE Passwörter. Die Client-ID ist öffentlich und darf im Code stehen.

export const CONFIG = {
  // OAuth-Client-ID aus der Google Cloud Console (siehe docs/google-einrichtung.md).
  // Endet auf ".apps.googleusercontent.com".
  GOOGLE_CLIENT_ID: "HIER-CLIENT-ID-EINTRAGEN.apps.googleusercontent.com",

  // Die beiden Drive-Ordner „Noten“. Jeder Unterordner ist ein Stück.
  NOTEN_ORDNER: [
    { id: "1x8tVwolO0y1TMN0oCD0Fid6dVHDAsOIk", name: "Noten (musikzugtvs1)" },
    { id: "1RRCxuh4ViIX06kJ63JLJKSNgS7sLm2eq", name: "Noten (musikzugtvs2)" },
  ],
};
