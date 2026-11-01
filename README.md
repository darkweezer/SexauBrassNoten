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
├── instruments.js         Zuordnung der Instrument-Schreibweisen (z. B. Trp → Trompete)
├── config.js              Einstellungen: Client-ID und die zwei Noten-Ordner
├── sw.js                  Service Worker für Offline-Betrieb
├── manifest.webmanifest   Installationsdaten der PWA
├── docs/
│   └── google-einrichtung.md  Klick-Anleitung für die Google-Anmeldung
└── icons/                 Logo und App-Symbole (aus dem Sexau-Brass-Logo erzeugt)
```

## Stand des Projekts

- [x] Grundgerüst der Oberfläche mit Suche, Stimmenfilter und Offline-Bereich
- [x] Offline-Speicher in IndexedDB (Speichern, Öffnen, Löschen, Speicherverbrauch)
- [x] Service Worker für Offline-Start
- [x] Installierbar (Manifest)
- [x] App-Symbole aus dem Sexau-Brass-Logo
- [x] Google-Login (Zugang über Testnutzer-Liste und Drive-Freigabe)
- [x] Anbindung an die Google Drive API (beide Ordner, Stückliste automatisch)
- [x] Filter nach Instrument, „Meine Stimmen offline speichern“
- [x] Google-Cloud-Projekt „SBNotenarchiv“ angelegt, Client-ID in `config.js` eingetragen
- [x] Instrumentnamen vereinheitlicht (255 Schreibweisen → 30 Instrumente, Liste in `instruments.js`)
- [x] Logo und dunkles Design (Schwarz/Gold)
- [x] Verwaltung: Stücke und Instrumente aktiv/nicht aktiv schalten (nur für Adressen in `config.js` → `VERWALTUNG`)
- [ ] Datenbank nur, falls später wirklich nötig
- [ ] Anleitung „So installieren Sie die App“ mit Bildern
- [ ] Hosting über GitHub Pages: https://darkweezer.github.io/SexauBrassNoten/ (Repository muss dafür öffentlich sein)

## Lokal ausprobieren

PWA-Funktionen (Service Worker) brauchen HTTPS oder `localhost`. Einfach im Projektordner starten:

```bash
cd notenapp
python3 -m http.server 8000
```

Dann im Browser `http://localhost:8000` öffnen.

Damit die Anmeldung lokal klappt, muss `http://localhost:8000` in der Google Cloud Console als
JavaScript-Quelle eingetragen sein.

## Online stellen (GitHub Pages)

1. Repository öffentlich machen: GitHub → Settings → ganz unten „Change visibility“ → „Make public“.
2. GitHub → Settings → Pages → bei „Source“ **Deploy from a branch** wählen, Branch **main**, Ordner **/ (root)** → **Save**.
3. Nach 1–2 Minuten ist die App erreichbar unter https://darkweezer.github.io/SexauBrassNoten/
4. In der Google Cloud Console beim Client `https://darkweezer.github.io` als JavaScript-Quelle eintragen.

Jede Änderung auf `main` ist danach automatisch nach 1–2 Minuten online.

## Neue Noten hinzufügen

In einem der beiden Drive-Ordner „Noten“ einen Ordner `Nummer_Titel` anlegen (z. B. `330_Neues_Stueck`)
und die PDFs hineinlegen, am besten benannt als `Titel_Instrument_Stimme.pdf` (z. B. `Neues_Stueck_Trompete_1.pdf`).
In der App erscheint das Stück nach dem nächsten Öffnen oder über Hilfe → „Notenliste neu laden“.

## Verwaltung (aktive Stücke und Instrumente)

Wer in `config.js` unter `VERWALTUNG` steht, sieht nach dem Anmelden den Bereich **Verwaltung**.
Oben schaltet man zwischen zwei Seiten um:

- **Stücke**: Index aller Stücke (Nummer, Titel) mit Schalter „aktiv“. Nicht aktive Stücke sind für alle
  ausgeblendet (lassen sich aber mit einem Haken wieder einblenden).
- **Instrumente**: alle erkannten Instrumente mit Schalter „aktiv“. Nicht aktive Instrumente fehlen in der
  Auswahl „Mein Instrument“; darunter blendet ein Haken sie bei Bedarf wieder ein.

Gespeichert wird beides zusammen in der Datei `notenarchiv-aktive-stuecke.json` im ersten Noten-Ordner in Drive.
Sie enthält nur, was nicht aktiv ist, neue Stücke und Instrumente sind also automatisch aktiv.
Speichern kann nur, wer Schreibrechte in diesem Ordner hat; die Liste in `config.js` blendet nur die Seite ein.

## Instrumente

Die Dateinamen in den Drives schreiben Instrumente sehr unterschiedlich (z. B. `Trp`, `Trompete`, `Trumpet`).
`instruments.js` fasst sie zusammen. Taucht eine neue Schreibweise auf und landet unter „Sonstige“,
einfach in `instruments.js` beim passenden Instrument ergänzen. Stimmen für mehrere Instrumente
(z. B. `Oboe_Glockenspiel`) erscheinen bei beiden.

## Hinweise

- Offline-Speicher ist pro Gerät. Auf iOS sollte die App unbedingt zum Home-Bildschirm hinzugefügt werden.
- Beim Löschen einer PDF im Offline-Bereich wird nur die lokale Kopie entfernt, nicht die Datei in Drive.
