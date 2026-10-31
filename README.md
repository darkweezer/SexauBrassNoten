# Notenarchiv (PWA)

Eine kleine Webanwendung, mit der die Mitglieder des Musikzugs Notenblätter (PDF) finden, öffnen und für die Offline-Nutzung auf dem eigenen Gerät speichern können.

## Anforderungen (Stand: Vorgespräch)

- Musiknoten als PDF, verteilt auf **zwei Google-Drive-Konten**
- **Suche und Auswahl** nach Titel, Nummer und Instrument
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
| Login | Google-Anmeldung im Browser; Zugangsliste = Testnutzer im Google-Cloud-Projekt + Drive-Freigabe |
| Stückliste | Wird live aus den Drive-Ordnern gelesen (Ordnername = Nr. und Titel, Dateiname = Stimme) und auf dem Gerät zwischengespeichert |
| PDFs | Bleiben in den zwei Google Drives, werden über die Drive-API geladen |
| Pflege | Noten einfach in Drive ablegen, ein Ordner pro Stück. Kein eigener Admin-Bereich nötig |

## Projektstruktur

```
notenapp/
├── README.md              diese Datei
├── index.html             Oberfläche
├── styles.css             Gestaltung
├── app.js                 Logik: Suche, Filter, Offline-Speicher
├── drive.js               Google-Anmeldung, Drive auslesen, PDFs laden
├── config.js              Einstellungen: Client-ID und die zwei Noten-Ordner
├── sw.js                  Service Worker für Offline-Betrieb
├── manifest.webmanifest   Installationsdaten der PWA
├── docs/
│   └── google-einrichtung.md  Klick-Anleitung für die Google-Anmeldung
└── icons/                 App-Symbole (192 und 512 px, PNG)
```

## Stand des Projekts

- [x] Grundgerüst der Oberfläche mit Suche, Stimmenfilter und Offline-Bereich
- [x] Offline-Speicher in IndexedDB (Speichern, Öffnen, Löschen, Speicherverbrauch)
- [x] Service Worker für Offline-Start
- [x] Installierbar (Manifest)
- [ ] App-Symbole als PNG (Platzhalter in `icons/`)
- [x] Google-Login (Zugang über Testnutzer-Liste und Drive-Freigabe)
- [x] Anbindung an die Google Drive API (beide Ordner, Stückliste automatisch)
- [x] Filter nach Instrument, „Meine Stimmen offline speichern“
- [ ] Google-Cloud-Projekt anlegen und Client-ID in `config.js` eintragen (siehe `docs/google-einrichtung.md`)
- [ ] Instrumentnamen vereinheitlichen (z. B. „Trp“ und „Trompete“)
- [ ] Datenbank / Admin-Bereich nur, falls später wirklich nötig
- [ ] Anleitung „So installieren Sie die App“ mit Bildern
- [ ] Hosting über Netlify (Repository bleibt privat)

## Lokal ausprobieren

PWA-Funktionen (Service Worker) brauchen HTTPS oder `localhost`. Einfach im Projektordner starten:

```bash
cd notenapp
python3 -m http.server 8000
```

Dann im Browser `http://localhost:8000` öffnen.

Damit die Anmeldung lokal klappt, muss `http://localhost:8000` in der Google Cloud Console als
JavaScript-Quelle eingetragen sein.

## Neue Noten hinzufügen

In einem der beiden Drive-Ordner „Noten“ einen Ordner `Nummer_Titel` anlegen (z. B. `330_Neues_Stueck`)
und die PDFs hineinlegen, am besten benannt als `Titel_Instrument_Stimme.pdf` (z. B. `Neues_Stueck_Trompete_1.pdf`).
In der App erscheint das Stück nach dem nächsten Öffnen oder über Hilfe → „Notenliste neu laden“.

## Hinweise

- Offline-Speicher ist pro Gerät. Auf iOS sollte die App unbedingt zum Home-Bildschirm hinzugefügt werden.
- Beim Löschen einer PDF im Offline-Bereich wird nur die lokale Kopie entfernt, nicht die Datei in Drive.
