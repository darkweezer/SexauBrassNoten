// Notenarchiv – Google-Anmeldung und Zugriff auf Google Drive
//
// Ablauf:
// 1. Die Person meldet sich mit Google an (Google Identity Services, nur im Browser).
// 2. Google gibt ein Zugriffs-Token zurück (gilt ca. 1 Stunde, nur Lesen).
// 3. Mit dem Token werden beide Noten-Ordner ausgelesen und PDFs geladen.
//
// Es gibt keinen eigenen Server. Wer die Drive-Ordner sehen darf, sieht die Noten.

import { findInstruments, SONSTIGE } from "./instruments.js";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
// Nur für Verwaltende: darf ausschließlich Dateien ändern, die diese App selbst angelegt hat
const FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let pendingToken = null;
let grantedScopes = "";

// ---------- Anmeldung ----------

function loadGoogleScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google-Anmeldung konnte nicht geladen werden. Besteht eine Internetverbindung?"));
    document.head.append(s);
  });
}

export async function initAuth(clientId) {
  await loadGoogleScript();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: () => {}, // wird pro Anfrage gesetzt
  });
}

export function isSignedIn() {
  return Boolean(accessToken) && Date.now() < tokenExpiresAt;
}

/**
 * Fordert ein Token an. Muss beim ersten Mal direkt aus einem Klick heraus
 * aufgerufen werden, sonst blockiert der Browser das Google-Fenster.
 * interactive=false versucht es still (ohne Fenster), falls schon einmal zugestimmt wurde.
 */
export function signIn({ interactive = true, withWrite = false } = {}) {
  if (!tokenClient) return Promise.reject(new Error("Anmeldung ist noch nicht bereit."));
  // Eine laufende stille Anfrage darf einen Klick auf „Anmelden“ nicht blockieren
  if (pendingToken && !interactive) return pendingToken;
  pendingToken = new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      pendingToken = null;
      if (resp.error) return reject(new Error(loginErrorText(resp.error)));
      accessToken = resp.access_token;
      grantedScopes = resp.scope ?? "";
      // eine Minute Puffer, damit das Token nicht mitten im Download abläuft
      tokenExpiresAt = Date.now() + (Number(resp.expires_in) - 60) * 1000;
      try { localStorage.setItem("notenarchiv.angemeldet", "1"); } catch {}
      resolve();
    };
    tokenClient.error_callback = (err) => {
      pendingToken = null;
      const texts = {
        popup_closed: "Anmeldung abgebrochen.",
        popup_failed_to_open: "Das Google-Fenster wurde blockiert. Bitte Pop-ups für diese Seite erlauben und erneut tippen.",
      };
      console.warn("Google-Anmeldung:", err);
      reject(new Error(texts[err?.type] ?? `Anmeldung nicht möglich (${err?.type ?? "unbekannt"}).`));
    };
    const request = { prompt: interactive ? "" : "none" };
    if (withWrite) request.scope = `${SCOPE} ${FILE_SCOPE}`;
    tokenClient.requestAccessToken(request);
  });
  return pendingToken;
}

export function canWrite() {
  return isSignedIn() && grantedScopes.includes(FILE_SCOPE);
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  try { localStorage.removeItem("notenarchiv.angemeldet"); } catch {}
}

export function wasSignedInBefore() {
  try { return localStorage.getItem("notenarchiv.angemeldet") === "1"; } catch { return false; }
}

function loginErrorText(code) {
  if (code === "access_denied") return "Zugriff verweigert. Bitte beim Notenwart freischalten lassen.";
  return "Anmeldung nicht möglich. Bitte erneut versuchen.";
}

// ---------- Drive-Anfragen ----------

export class NotLoggedInError extends Error {
  constructor() { super("Bitte neu anmelden."); this.name = "NotLoggedInError"; }
}

async function driveFetch(url, options = {}) {
  if (!isSignedIn()) {
    // still erneuern versuchen; klappt meist, wenn die Person schon zugestimmt hat
    try { await signIn({ interactive: false }); } catch { throw new NotLoggedInError(); }
  }
  const res = await fetch(url, { ...options, headers: { ...(options.headers ?? {}), Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) { accessToken = null; throw new NotLoggedInError(); }
  if (res.status === 403 || res.status === 404) {
    throw new Error("Kein Zugriff auf diese Noten. Bitte beim Notenwart freischalten lassen.");
  }
  if (!res.ok) throw new Error(`Google Drive antwortet nicht (Fehler ${res.status}).`);
  return res;
}

/** Holt alle Treffer einer Drive-Suche, Seite für Seite. */
async function listAll(query, fields) {
  const out = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: query,
      fields: `nextPageToken, files(${fields})`,
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await driveFetch(`${API}?${params}`)).json();
    out.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

function inParents(ids) {
  return "(" + ids.map((id) => `'${id.replace(/'/g, "\\'")}' in parents`).join(" or ") + ")";
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Liest beide Noten-Ordner aus und baut daraus die Stückliste.
 * Ergebnis: [{ id, number, title, files: [{ id, name, voice, instrument, size }] }]
 */
export async function loadSongsFromDrive(rootFolders) {
  // 1. Stück-Ordner in allen Wurzelordnern
  const folders = await listAll(
    `${inParents(rootFolders.map((r) => r.id))} and mimeType = '${FOLDER_MIME}' and trashed = false`,
    "id, name",
  );

  // 2. PDFs in den Stück-Ordnern (in Gruppen, damit die Anfrage nicht zu lang wird)
  //    (über 8.000 PDFs: Gruppen laufen gleichzeitig, das spart Wartezeit)
  const groups = chunk(folders.map((f) => f.id), 40);
  const results = await Promise.all(groups.map((group) => listAll(
    `${inParents(group)} and mimeType = 'application/pdf' and trashed = false`,
    "id, name, parents, size",
  )));
  const pdfs = results.flat();

  return buildSongs(folders, pdfs);
}

/** Lädt eine PDF-Datei als Blob. */
export async function downloadPdf(fileId) {
  const res = await driveFetch(`${API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  return res.blob();
}

/** Google-Adresse der angemeldeten Person (für die Verwaltungs-Berechtigung). */
export async function getUserEmail() {
  const res = await driveFetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)");
  const data = await res.json();
  return String(data.user?.emailAddress ?? "").toLowerCase();
}

// ---------- Aktive Stücke (kleine JSON-Datei in Drive) ----------
// Inhalt: { "inaktiv": ["<Ordner-ID>", …], "geaendert": "2026-…", "von": "name@gmail.com" }
// Gespeichert wird nur, welche Stücke INAKTIV sind. Neue Stücke sind damit automatisch aktiv.

async function findStatusFile(folderId, fileName) {
  const files = await listAll(
    `'${folderId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`,
    "id, modifiedTime",
  );
  files.sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
  return files[0] ?? null;
}

export async function loadStatus({ folderId, fileName }) {
  const file = await findStatusFile(folderId, fileName);
  if (!file) return { inaktiv: [], fileId: null };
  const res = await driveFetch(`${API}/${file.id}?alt=media&supportsAllDrives=true`);
  const data = await res.json().catch(() => ({}));
  return { inaktiv: Array.isArray(data.inaktiv) ? data.inaktiv : [], geaendert: data.geaendert, von: data.von, fileId: file.id };
}

export async function saveStatus({ folderId, fileName, fileId, inaktiv, von }) {
  const body = JSON.stringify({ inaktiv, geaendert: new Date().toISOString(), von }, null, 2);
  if (fileId) {
    const res = await driveFetch(`${UPLOAD}/${fileId}?uploadType=media&supportsAllDrives=true&fields=id`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body,
    });
    return (await res.json()).id;
  }
  // Datei anlegen (mehrteilige Anfrage: Metadaten + Inhalt)
  const boundary = "notenarchiv" + Date.now();
  const meta = JSON.stringify({ name: fileName, parents: [folderId], mimeType: "application/json" });
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await driveFetch(`${UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart,
  });
  return (await res.json()).id;
}

// ---------- Namen auswerten ----------
// Ordner:  "255_Nessaja"                     -> Nr. 255, Titel "Nessaja"
// Datei:   "Nessaja_Altsax_1.pdf"            -> Stimme "Altsax 1", Instrument "Altsaxophon"
// Datei:   "273_Kings_of_Swing_Horn_1_F.pdf" -> Stimme "Horn 1 F", Instrument "Horn"
// Die Zuordnung der Instrumente steht in instruments.js.

export function parseFolderName(name) {
  const m = String(name).trim().match(/^(\d+)[_\s-]+(.*)$/);
  const number = m ? Number(m[1]) : null;
  const rest = (m ? m[2] : name).replace(/_+/g, " ").trim();
  return { number, title: rest || String(name) };
}

// Kleinbuchstaben, Umlaute ausschreiben (ö -> oe), damit "Dankeschön" und "Dankeschoen" passen
const norm = (s) => s.toLowerCase()
  .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// "AltSax1" -> "AltSax 1", "Seite2" -> "Seite 2"
const spaceDigits = (s) => s.replace(/([A-Za-zäöüÄÖÜß])(\d)/g, "$1 $2");

const PITCH = /^(b|c|es|f|in)$/i;

export function parseFileName(fileName, songTitle) {
  const base = String(fileName).replace(/\.pdf$/i, "");
  let tokens = base.split(/[_\s-]+/).filter(Boolean);

  // führende Stücknummer entfernen ("273_…")
  if (tokens.length > 1 && /^\d+$/.test(tokens[0])) tokens = tokens.slice(1);

  // Titelwörter am Anfang entfernen, wenn sie zum Ordnernamen passen
  const titleTokens = String(songTitle).split(/[_\s-]+/).filter(Boolean).map(norm);
  let i = 0;
  while (i < titleTokens.length && i < tokens.length - 1 && norm(tokens[i]) === titleTokens[i]) i++;
  let voiceTokens = tokens.slice(i);

  const found = findInstruments(voiceTokens);

  // Passte der Titel nicht zum Ordnernamen (z. B. "Phantom_AltSax1" im Ordner "The Phantom of the opera"),
  // beginnt die Stimmenbezeichnung beim ersten Instrument. Eine Tonart davor ("Es_Horn") bleibt dabei.
  if (found && i === 0 && found.index > 0) {
    let from = found.index;
    if (PITCH.test(tokens[from - 1])) from--;
    voiceTokens = tokens.slice(from);
  }

  const voice = spaceDigits(voiceTokens.join(" ")) || base;
  const instruments = found?.instruments ?? [SONSTIGE];
  return { voice, instrument: instruments[0], instruments };
}

export function buildSongs(folders, pdfs) {
  const byFolder = new Map();
  for (const pdf of pdfs) {
    for (const parent of pdf.parents ?? []) {
      if (!byFolder.has(parent)) byFolder.set(parent, []);
      byFolder.get(parent).push(pdf);
    }
  }

  return folders
    .map((folder) => {
      const { number, title } = parseFolderName(folder.name);
      const files = (byFolder.get(folder.id) ?? [])
        .map((pdf) => ({
          id: pdf.id,
          name: pdf.name,
          size: Number(pdf.size) || 0,
          ...parseFileName(pdf.name, title),
        }))
        .sort((a, b) => a.voice.localeCompare(b.voice, "de", { numeric: true }));
      return { id: folder.id, number, title, files };
    })
    .filter((song) => song.files.length > 0);
}
