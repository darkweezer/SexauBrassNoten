# Notenarchiv (PWA)

Eine kleine Webanwendung, mit der Chor- und Bandmitglieder Notenblätter (PDF) finden, öffnen und für die Offline-Nutzung auf dem eigenen Gerät speichern können.

## Anforderungen (Stand: Vorgespräch)

- Musiknoten als PDF, verteilt auf **zwei Google-Drive-Konten**
- **Suche und Auswahl** nach Titel, Komponist, Stimme
- **Offline-Nutzung** für ca. **100 PDFs** pro Gerät
- Geräte: Android, iOS, Tablet, PC
- **Einfache Bedienung** für nicht technische Nutzer
- Zugang nur für freigeschaltete Personen (Google-Login + Allowlist)
- **Hochladen/Pflegen** durch 2–3 Admins
- Keine feingranulare Offline-Rechteverwaltung

## Architekturidee

| Bereich | Umsetzung |
|---|---|
| Oberfläche | PWA (HTML, CSS, JavaScript), installierbar auf dem Startbildschirm |
| Offline | Service Worker (App-Hülle), IndexedDB (PDFs und Stückliste) |
| Login | Google-Anmeldung, Allowlist der E-Mail-Adressen |
| Metadaten | Datenbank (Vorschlag: Supabase), Tabellen `songs` und `files` |
| PDFs | Bleiben in den zwei Google Drives, werden über die Drive-API geladen |
| Admin | Metadaten pflegen, Index aus Drive aktualisieren, Nutzer freischalten |

## Projektstruktur

```
notenapp/
├── README.md              diese Datei
├── index.html             Oberfläche
├── styles.css             Gestaltung
├── app.js                 Logik: Suche, Filter, Offline-Speicher
├── sw.js                  Service Worker für Offline-Betrieb
├── manifest.webmanifest   Installationsdaten der PWA
├── data/
│   └── songs.json         Beispieldaten (werden später durch Datenbank ersetzt)
└── icons/                 App-Symbole (192 und 512 px, PNG)
```

## Stand des Projekts

- [x] Grundgerüst der Oberfläche mit Suche, Stimmenfilter und Offline-Bereich
- [x] Offline-Speicher in IndexedDB (Speichern, Öffnen, Löschen, Speicherverbrauch)
- [x] Service Worker für Offline-Start
- [x] Installierbar (Manifest)
- [ ] App-Symbole als PNG (Platzhalter in `icons/`)
- [ ] Google-Login mit Allowlist
- [ ] Anbindung an die Google Drive API (beide Drives)
- [ ] Datenbank statt `songs.json`
- [ ] Admin-Bereich (Hochladen, Metadaten, Freischaltung)
- [ ] Anleitung „So installieren Sie die App“ mit Bildern
- [ ] Hosting (z. B. Netlify, Cloudflare Pages oder GitHub Pages, jeweils mit HTTPS)

## Lokal ausprobieren

PWA-Funktionen (Service Worker) brauchen HTTPS oder `localhost`. Einfach im Projektordner starten:

```bash
cd notenapp
python3 -m http.server 8000
```

Dann im Browser `http://localhost:8000` öffnen.

## Hinweise

- Die Datei `data/songs.json` enthält nur Beispieleinträge mit Platzhalter-Links.
- Offline-Speicher ist pro Gerät. Auf iOS sollte die App unbedingt zum Home-Bildschirm hinzugefügt werden.
- Beim Löschen einer PDF im Offline-Bereich wird nur die lokale Kopie entfernt, nicht die Datei in Drive.
