# Google-Anmeldung einrichten (einmalig, ca. 15 Minuten)

Damit sich Musikerinnen und Musiker in der App mit Google anmelden können, braucht die App eine
**Client-ID** von Google. Die gibt es kostenlos in der Google Cloud Console. Das muss nur **einmal** gemacht werden.

> **Tipp:** Am besten mit einem Vereinskonto (z. B. dem Konto, dem die Noten-Ordner gehören) einrichten,
> damit die Einrichtung nicht an einer einzelnen Person hängt.

## 1. Projekt anlegen

1. <https://console.cloud.google.com> öffnen und mit dem Google-Konto anmelden.
2. Beim ersten Mal den Nutzungsbedingungen zustimmen.
3. Oben links auf die Projektauswahl klicken → **Neues Projekt**.
4. Name: `NotenApp` → **Erstellen**. Danach sicherstellen, dass oben „NotenApp“ ausgewählt ist.

## 2. Google Drive API einschalten

1. Oben in das Suchfeld **Google Drive API** eingeben und das Ergebnis öffnen.
2. Auf **Aktivieren** klicken.

## 3. Anmeldebildschirm einrichten

1. Im Suchfeld **Google Auth Platform** eingeben und öffnen → **Jetzt starten**.
2. **App-Informationen:** App-Name `NotenApp`, Support-E-Mail auswählen → **Weiter**.
3. **Zielgruppe:** **Extern** wählen → **Weiter**.
4. **Kontaktdaten:** eigene E-Mail eintragen → **Weiter**, zustimmen → **Erstellen**.

## 4. Zugriff „nur lesen“ auf Drive erlauben

1. Links auf **Datenzugriff** → **Bereiche hinzufügen oder entfernen**.
2. Im Filter `drive.readonly` eingeben, den Eintrag
   `.../auth/drive.readonly` anhaken → **Aktualisieren** → unten **Speichern**.

3. Auf die gleiche Weise auch `.../auth/drive.file` hinzufügen und speichern.

Mit `drive.readonly` kann die App Noten **nur ansehen und herunterladen**, aber nichts ändern oder löschen.
`drive.file` brauchen nur Verwaltende: Damit darf die App ausschließlich die eine Datei
`notenarchiv-aktive-stuecke.json` anlegen und ändern, die sie selbst erstellt hat. Musiker werden danach nicht gefragt.

## 5. Musiker freischalten (das ist die Zugangsliste)

1. Links auf **Zielgruppe**. Der Status bleibt auf **Test** (nicht „Veröffentlichen“ klicken).
2. Unter **Testnutzer** → **Nutzer hinzufügen** die Google-E-Mail-Adressen der Musiker eintragen
   (bis zu 100 Personen) → **Speichern**.
   Adressen mit `@googlemail.com` immer als `@gmail.com` eintragen, sonst lehnt Google sie ab.

Wichtig: Dieselben Personen müssen **beide Drive-Ordner „Noten“** sehen dürfen
(in Google Drive: Ordner → Teilen → als „Betrachter“ hinzufügen).

Neue Person freischalten = hier als Testnutzer eintragen **und** beide Ordner mit ihr teilen.
Person entfernen = an beiden Stellen wieder austragen.

## 6. Client-ID erstellen

1. Links auf **Clients** → **Client erstellen**.
2. Anwendungstyp: **Webanwendung**, Name: `NotenApp Web`.
3. Unter **Autorisierte JavaScript-Quellen** zwei Einträge hinzufügen:
   - `https://darkweezer.github.io` (Adresse der App bei GitHub Pages, ohne Schrägstrich am Ende)
   - `http://localhost:8000`
4. „Autorisierte Weiterleitungs-URIs“ leer lassen → **Erstellen**.
5. Die angezeigte **Client-ID** kopieren (endet auf `.apps.googleusercontent.com`).
   Ein „Clientschlüssel“ (Secret) wird **nicht** gebraucht und darf nirgends eingetragen werden.

## 7. Client-ID eintragen

Die Client-ID in `config.js` bei `GOOGLE_CLIENT_ID` eintragen (oder an Claude schicken).
Die Client-ID ist kein Geheimnis und darf öffentlich im Code stehen.

## Was die Musiker beim ersten Anmelden sehen

- Google zeigt den Hinweis **„Google hat diese App nicht überprüft“**. Das ist im Testmodus normal.
  Auf **Weiter** tippen.
- Danach fragt Google, ob die App Drive-Dateien **ansehen** darf → **Weiter** / **Zulassen**.
- Im Testmodus verlangt Google etwa **alle 7 Tage eine neue Anmeldung**. Offline gespeicherte Noten
  bleiben dabei erhalten und sind auch ohne Anmeldung nutzbar.

## Datenschutz in Kürze

- Es gibt **keinen eigenen Server**. Die Anmeldung läuft direkt zwischen Gerät und Google.
- Das Zugriffs-Token bleibt nur im Browser des jeweiligen Geräts und läuft nach einer Stunde ab.
- Die App liest nur die beiden Noten-Ordner. Technisch erlaubt der Lese-Zugriff zwar das Ansehen
  aller Drive-Dateien der angemeldeten Person, die App fragt aber nur die Noten-Ordner ab.
