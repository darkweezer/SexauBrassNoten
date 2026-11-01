// NotenApp – Hauptlogik
// Noten kommen live aus den zwei Google-Drive-Ordnern (siehe drive.js und config.js).
// Offline-Kopien liegen in IndexedDB auf dem Gerät.

import { CONFIG } from "./config.js";
import {
  initAuth, signIn, signOut, isSignedIn, wasSignedInBefore, canWrite,
  loadSongsFromDrive, downloadPdf, NotLoggedInError,
  getUserEmail, loadStatus, saveStatus,
} from "./drive.js";
import { INSTRUMENT_ORDER, SONSTIGE, findInstruments, isCollectionTitle } from "./instruments.js";
import { openViewer, renderPdfStrip } from "./viewer.js";
import { labelVariants, parseVoice } from "./labels.js";
import { initPrint, renderPrint } from "./print.js";

const DB_NAME = "notenarchiv";
const DB_VERSION = 1;
const STORE_PDFS = "pdfs";      // key: fileId, value: { id, songId, voice, title, blob, savedAt }
const MAX_OFFLINE_FILES = 400;  // Obergrenze, damit der Gerätespeicher nicht überläuft
const LS_SONGS = "notenarchiv.stueckliste.v2"; // v2: Instrumente zusammengefasst
const LS_INSTRUMENT = "notenarchiv.instrument";
const LS_STIMME = "notenarchiv.stimme";
const LS_STATUS = "notenarchiv.inaktiv";
const LS_USER = "notenapp.nutzer";
const LS_SOLO = "notenapp.solo";

const state = {
  songs: [],          // [{ id, number, title, files: [{ id, name, voice, instrument, instruments, size }] }]
  offline: new Map(), // fileId -> Eintrag aus IndexedDB (ohne Blob)
  saving: new Map(),  // songId -> Fortschrittstext beim Offline-Speichern
  expanded: new Set(), // aufgeklappte Stücke
  loading: false,
  inaktiv: new Set(), // Ordner-IDs der Stücke, die gerade nicht gespielt werden
  statusFileId: null,
  statusInfo: null,   // { geaendert, von }
  email: "",
  isAdmin: false,
  instInaktiv: new Set(), // Instrumente, die gerade nicht besetzt sind
  draft: null,        // Verwaltung: noch nicht gespeicherte Änderungen { stuecke: Set, instrumente: Set }
  adminMode: "stuecke",
  zuordnung: {},      // von der Verwaltung korrigierte Stimmen: "<songId>|<Stimme>" -> { inst, nr, st }
  zVersion: 0,
  assignOpen: new Set(),
  assignExtra: new Map(), // Verwaltung: Zeilen inkl. noch leerer Zeilen je Stimme
};

// ---------- Hilfsfunktionen ----------

const $ = (sel) => document.querySelector(sel);

function toast(message, ms = 2600) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? `${Math.round(bytes / 1024)} KB` : `${mb.toFixed(1)} MB`;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Eine Stimme kann für mehrere Instrumente gelten ("Oboe_Glockenspiel")
const rawInstruments = (f) => f.instruments ?? (f.instrument ? [f.instrument] : null)
  ?? findInstruments(String(f.voice).split(" "))?.instruments ?? [SONSTIGE];

// Zuordnung aus der Verwaltung (überschreibt, was aus dem Dateinamen erkannt wurde)
let fileSongIndex = new Map();
let fileSongIndexFor = null;
function songIdOf(f) {
  if (f.songId) return f.songId;
  if (fileSongIndexFor !== state.songs) {
    fileSongIndex = new Map();
    fileSongIndexFor = state.songs;
    for (const song of state.songs) for (const file of song.files) fileSongIndex.set(file.id, song.id);
  }
  return fileSongIndex.get(f.id);
}
const zuordnungKey = (songId, f) => `${songId}|${voiceBase(f.voice)}`;
// Eine Zuordnung besteht aus Zeilen { inst, nr, st } – ein Blatt kann mehrere Instrumente UND Stimmen enthalten.
// (Ältere Form { inst: [...], nr, st } wird in Zeilen umgerechnet.)
function overrideLines(o) {
  if (!o) return [];
  if (Array.isArray(o.zeilen)) return o.zeilen.filter((z) => z.inst || z.nr || z.st);
  const insts = o.inst?.length ? o.inst : [""];
  return insts.map((inst) => ({ inst, nr: o.nr ?? "", st: o.st ?? "" })).filter((z) => z.inst || z.nr || z.st);
}

function overrideFor(f, z = state.zuordnung) {
  const lines = overrideLines(z?.[zuordnungKey(songIdOf(f), f)]);
  return lines.length ? lines : null;
}

const fileInstruments = (f) => {
  const lines = overrideFor(f);
  const insts = lines ? [...new Set(lines.map((l) => l.inst).filter(Boolean))] : [];
  return insts.length ? insts : rawInstruments(f);
};
const fileHas = (f, instrument) => fileInstruments(f).includes(instrument);

// Stimmnummern aus dem Label lesen: "Trompete 2" -> [2], "Horn 3u 4 Es" -> [3, 4], "Tuba (S.1)" -> []
// Seitenzahlen "(S.x)" und lange Zahlen (Scan-Nummern) zählen nicht.
function voiceNumbers(f) {
  const lines = overrideFor(f);
  const nrs = lines ? [...new Set(lines.map((l) => Number(l.nr)).filter(Boolean))] : [];
  if (nrs.length) return nrs.sort((a, b) => a - b);
  if (!f._nums) {
    const tokens = String(f.voice).replace(/\(S\.\d+\)/g, " ").split(/[\s/,+]+/);
    const nums = new Set();
    for (const t of tokens) {
      const m = /^(\d)(?:[a-z]|u\d?)?$/i.exec(t);
      if (m && m[1] !== "0") nums.add(Number(m[1]));
      const both = /^(\d)u(\d)$/i.exec(t);
      if (both) nums.add(Number(both[2]));
    }
    Object.defineProperty(f, "_nums", { value: [...nums].sort(), enumerable: false });
  }
  return f._nums;
}

// Passt eine Datei zu Instrument und Stimme? Stimmen ohne Nummer (z. B. "Tuba") gelten für alle Stimmen.
// Solo-Stimmen ("Solo Trp", "Solostimme B", "TenSax Solopart") sind beim Filtern ausgeblendet,
// außer der Haken „Auch Solo-Stimmen zeigen“ ist gesetzt.
const isSolo = (f) => /solo/i.test(String(f.voice));
const showSolo = () => Boolean(document.querySelector("#show-solo")?.checked);

function fileMatches(f, instrument, stimme) {
  const lines = overrideFor(f);
  if (lines && lines.some((l) => l.inst)) {
    // zugeordnet: eine Zeile muss zu Instrument UND Stimme passen (Zeilen ohne Stimme gelten für alle)
    return lines.some((l) => (!instrument || l.inst === instrument) && (!stimme || !l.nr || Number(l.nr) === Number(stimme)));
  }
  if (instrument && !fileHas(f, instrument)) return false;
  if ((instrument || stimme) && isSolo(f) && !showSolo()) return false;
  if (!stimme) return true;
  const nums = voiceNumbers(f);
  return nums.length === 0 || nums.includes(Number(stimme));
}

// Auswahl „Stimme“ mit den Nummern füllen, die es für das gewählte Instrument gibt
function fillStimmeSelect(select, files, instrument, stored) {
  const nums = new Set();
  for (const f of files) if (!instrument || fileHas(f, instrument)) for (const n of voiceNumbers(f)) nums.add(n);
  const current = select.value || stored || "";
  const list = [...nums].sort((a, b) => a - b);
  select.innerHTML = `<option value="">Alle</option>` + list.map((n) => `<option value="${n}">${n}.</option>`).join("");
  select.value = list.includes(Number(current)) ? String(current) : "";
}

function populateStimmeFilter() {
  fillStimmeSelect($("#stimme-filter"), state.songs.flatMap((s) => s.files), $("#voice-filter").value, lsGet(LS_STIMME));
}

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch {} }

// ---------- IndexedDB (Offline-Speicher) ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PDFS)) {
        db.createObjectStore(STORE_PDFS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRun(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PDFS, mode);
    const store = tx.objectStore(STORE_PDFS);
    const result = fn(store);
    tx.oncomplete = () => resolve(result?.result ?? undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function loadOfflineIndex() {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE_PDFS, "readonly").objectStore(STORE_PDFS).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  state.offline = new Map(all.map(({ blob, ...meta }) => [meta.id, { ...meta, size: blob?.size ?? 0 }]));
}

async function savePdf(entry, blob) {
  await dbRun("readwrite", (store) => store.put({ ...entry, blob, savedAt: Date.now() }));
  state.offline.set(entry.id, { ...entry, size: blob.size });
}

async function removePdf(fileId) {
  await dbRun("readwrite", (store) => store.delete(fileId));
  state.offline.delete(fileId);
}

async function getPdfBlob(fileId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_PDFS, "readonly").objectStore(STORE_PDFS).get(fileId);
    req.onsuccess = () => resolve(req.result?.blob ?? null);
    req.onerror = () => reject(req.error);
  });
}

// ---------- Stückliste ----------

function loadCachedSongs() {
  try {
    const data = JSON.parse(lsGet(LS_SONGS) ?? "null");
    if (data?.songs) {
      state.songs = data.songs;
      return data.loadedAt;
    }
  } catch {}
  return null;
}

async function refreshSongs() {
  if (state.loading) return;
  state.loading = true;
  $("#result-count").textContent = "Noten werden aus Google Drive geladen …";
  $("#result-count").classList.add("loading");
  try {
    const [songs] = await Promise.all([loadSongsFromDrive(CONFIG.NOTEN_ORDNER), refreshStatus()]);
    state.songs = songs;
    lsSet(LS_SONGS, JSON.stringify({ loadedAt: Date.now(), songs: state.songs }));
  } finally {
    state.loading = false;
    $("#result-count").classList.remove("loading");
  }
  populateInstrumentFilter();
  renderSongs();
  if (state.isAdmin) renderAdmin();
}

// ---------- Aktive Stücke ----------

function setZuordnung(z) {
  state.zuordnung = z ?? {};
  state.zVersion++;
}

function loadCachedStatus() {
  try {
    const data = JSON.parse(lsGet(LS_STATUS) ?? "null");
    if (Array.isArray(data?.inaktiv)) state.inaktiv = new Set(data.inaktiv);
    if (Array.isArray(data?.instrumenteInaktiv)) state.instInaktiv = new Set(data.instrumenteInaktiv);
    if (data?.zuordnung && typeof data.zuordnung === "object") setZuordnung(data.zuordnung);
  } catch {}
}

function cacheStatus() {
  lsSet(LS_STATUS, JSON.stringify({ inaktiv: [...state.inaktiv], instrumenteInaktiv: [...state.instInaktiv], zuordnung: state.zuordnung }));
}

async function refreshStatus() {
  try {
    const status = await loadStatus(CONFIG.STATUS_DATEI);
    // Entwurf in der Verwaltung nur verwerfen, wenn dort nichts ungespeichert ist
    if (state.draft && !draftChanged()) state.draft = null;
    state.inaktiv = new Set(status.inaktiv);
    state.instInaktiv = new Set(status.instrumenteInaktiv);
    setZuordnung(status.zuordnung ?? {});
    state.statusFileId = status.fileId;
    state.statusInfo = status.geaendert ? { geaendert: status.geaendert, von: status.von } : null;
    cacheStatus();
  } catch (err) {
    if (err instanceof NotLoggedInError) throw err;
    // ohne Status-Datei ist einfach alles aktiv
  }
}

const isActive = (song) => !state.inaktiv.has(song.id);
const isInstrumentActive = (name) => !state.instInaktiv.has(name);

async function checkAdmin() {
  try {
    state.email = await getUserEmail();
    if (state.email) lsSet(LS_USER, state.email); // für Zoom-Einstellungen auch ohne Internet
  } catch { state.email = ""; }
  const admins = (CONFIG.VERWALTUNG ?? []).map((a) => a.toLowerCase().replace("@googlemail.com", "@gmail.com"));
  state.isAdmin = admins.includes(state.email.replace("@googlemail.com", "@gmail.com"));
  $("#tab-admin").classList.toggle("hidden", !state.isAdmin);
  if (state.isAdmin) renderAdmin();
}

// ---------- Verwaltung ----------
// Zwei Seiten im Reiter „Verwaltung“: Stücke und Instrumente. Gespeichert wird beides zusammen.

const instrumentRank = (name) => { const i = INSTRUMENT_ORDER.indexOf(name); return i < 0 ? 999 : i; };

function allInstruments() {
  const counts = new Map();
  for (const s of state.songs) {
    const inSong = new Set();
    for (const f of s.files) for (const i of fileInstruments(f)) inSong.add(i);
    for (const i of inSong) counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  return [...counts].map(([name, songs]) => ({ name, songs }))
    .sort((a, b) => instrumentRank(a.name) - instrumentRank(b.name) || a.name.localeCompare(b.name, "de"));
}

function ensureDraft() {
  if (!state.draft) {
    state.draft = {
      stuecke: new Set(state.inaktiv), instrumente: new Set(state.instInaktiv),
      zuordnung: JSON.parse(JSON.stringify(state.zuordnung)),
    };
  }
  return state.draft;
}

function draftChanged() {
  const d = state.draft;
  return Boolean(d) && (!sameSet(d.stuecke, state.inaktiv) || !sameSet(d.instrumente, state.instInaktiv)
    || JSON.stringify(sortKeys(d.zuordnung)) !== JSON.stringify(sortKeys(state.zuordnung)));
}

function adminItems() {
  if (state.adminMode === "instrumente") {
    return allInstruments().map((i) => ({ key: i.name, num: "", label: i.name, meta: `in ${i.songs} ${i.songs === 1 ? "Stück" : "Stücken"}` }));
  }
  return [...state.songs]
    .sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title, "de"))
    .map((s) => ({ key: s.id, num: s.number ?? "–", label: s.title, meta: `${s.files.length} Dateien`, song: s }));
}

function renderAdmin() {
  const draft = ensureDraft();
  const isAssign = state.adminMode === "zuordnen";
  $("#assign-list").classList.toggle("hidden", !isAssign);
  $("#admin-table").classList.toggle("hidden", isAssign);
  $("#admin-bar").classList.toggle("hidden", isAssign);
  if (isAssign) {
    document.querySelectorAll("[data-admin-mode]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.adminMode === state.adminMode));
    renderAssign();
    renderSaveState();
    queuePreviews();
    return;
  }
  const isInst = state.adminMode === "instrumente";
  const set = isInst ? draft.instrumente : draft.stuecke;
  const query = $("#admin-search").value.trim().toLowerCase();
  const filter = $("#admin-filter").value;

  document.querySelectorAll("[data-admin-mode]").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.adminMode === state.adminMode));
  $("#admin-title").textContent = isInst ? "Instrumente verwalten" : "Stücke verwalten";
  $("#admin-intro").textContent = isInst
    ? "Nicht aktive Instrumente verschwinden aus der Auswahl „Mein Instrument“, z. B. weil sie gerade niemand spielt. Mit einem Haken lassen sie sich wieder einblenden."
    : "Hier legst du fest, welche Stücke gerade gespielt werden. Nicht aktive Stücke sind für alle ausgeblendet, bleiben aber in Drive erhalten.";
  $("#admin-search").placeholder = isInst ? "Instrument suchen" : "Titel oder Nummer suchen";
  $("#admin-filter").options[0].textContent = isInst ? "Alle Instrumente" : "Alle Stücke";
  $("#admin-col-num").classList.toggle("hidden", isInst);
  $("#admin-col-label").textContent = isInst ? "Instrument" : "Stück";

  const all = adminItems();
  const items = all
    .filter((it) => !query || (it.song ? matchesSearch(it.song, query) : it.label.toLowerCase().includes(query)))
    .filter((it) => filter === "alle" || (filter === "aktiv") === !set.has(it.key));

  const activeCount = all.filter((it) => !set.has(it.key)).length;
  $("#admin-count").textContent = `${activeCount} von ${all.length} ${isInst ? "Instrumenten" : "Stücken"} aktiv`;

  renderSaveState();

  $("#admin-list").innerHTML = items.map((it) => {
    const active = !set.has(it.key);
    return `
      <tr class="${active ? "" : "is-inactive"}">
        ${isInst ? "" : `<td class="num">${it.num}</td>`}
        <td>${escapeHtml(it.label)}<span class="admin-meta">${escapeHtml(it.meta)}</span></td>
        <td class="switch-cell">
          <label class="switch">
            <input type="checkbox" data-toggle-key="${escapeHtml(it.key)}" ${active ? "checked" : ""} />
            <span class="slider" aria-hidden="true"></span>
            <span class="visually-hidden">${escapeHtml(it.label)} aktiv</span>
          </label>
        </td>
      </tr>`;
  }).join("") || `<tr><td colspan="3" class="hint">Nichts gefunden.</td></tr>`;
}

function renderSaveState() {
  const changed = draftChanged();
  $("#admin-save").disabled = !changed;
  $("#admin-unsaved").classList.toggle("hidden", !changed);
  const info = state.statusInfo;
  $("#admin-info").textContent = info
    ? `Zuletzt gespeichert am ${new Date(info.geaendert).toLocaleString("de-DE")} von ${info.von}`
    : "Noch nichts gespeichert: Alles gilt als aktiv.";
}

// ---------- Verwaltung: Stimmen zuordnen ----------
// Für Dateien, deren Name das Instrument nicht verrät ("1_Stimme_B", Scans "CCF…"),
// legt die Verwaltung Instrument, Stimme und Stimmung fest. Gilt für alle Seiten-Dateien einer Stimme.

const UNCLEAR = new Set(["Stimme (frei besetzbar)", SONSTIGE]);
const PITCH_OPTIONS = ["B", "C", "Es", "F", "As", "Des", "G", "D"];
const isUnclear = (f) => rawInstruments(f).some((i) => UNCLEAR.has(i));

function assignVoices(song) {
  const groups = new Map();
  for (const f of song.files) {
    const base = voiceBase(f.voice);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(f);
  }
  return [...groups].map(([base, files]) => {
    files.sort((a, b) => voicePage(a.voice) - voicePage(b.voice));
    return { base, files, key: zuordnungKey(song.id, files[0]), unclear: files.some(isUnclear) };
  }).sort((a, b) => a.base.localeCompare(b.base, "de", { numeric: true }));
}

function renderAssign() {
  const draft = ensureDraft();
  const z = draft.zuordnung;
  const query = $("#admin-search").value.trim();
  const onlyUnclear = $("#admin-filter").value !== "alle";

  $("#admin-title").textContent = "Stimmen zuordnen";
  $("#admin-intro").textContent = "Für Dateien, deren Name das Instrument nicht verrät, hier Instrument, Stimme und Stimmung festlegen. "
    + "Mit „Öffnen“ siehst du das Notenblatt. Gilt für alle Seiten einer Stimme und für alle Musiker.";
  $("#admin-search").placeholder = "Titel oder Nummer suchen";
  const sel = $("#admin-filter");
  if (sel.dataset.mode !== "zuordnen") {
    sel.innerHTML = `<option value="unklar">Nur unklare Stimmen</option><option value="alle">Alle Stimmen</option>`;
    sel.dataset.mode = "zuordnen";
  }

  const songs = [...state.songs]
    .sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title, "de"))
    .filter((s) => matchesSearch(s, query))
    .map((song) => {
      const voices = assignVoices(song).filter((v) => !onlyUnclear || v.unclear || z[v.key]);
      return { song, voices };
    })
    .filter((x) => x.voices.length);

  const instOptions = (selected) => `<option value="">–</option>` + INSTRUMENT_ORDER
    .filter((n) => !UNCLEAR.has(n))
    .map((n) => `<option value="${escapeHtml(n)}" ${n === selected ? "selected" : ""}>${escapeHtml(niceInstrument(n))}</option>`).join("");
  const opts = (list, selected, empty = "–") => `<option value="">${empty}</option>` +
    list.map((v) => `<option value="${v}" ${String(v) === String(selected ?? "") ? "selected" : ""}>${v}</option>`).join("");

  $("#assign-list").innerHTML = songs.map(({ song, voices }) => {
    const open = state.assignOpen.has(song.id) || Boolean(query);
    const done = voices.filter((v) => z[v.key]).length;
    return `
      <details class="assign-song" data-song="${escapeHtml(song.id)}" ${open ? "open" : ""}>
        <summary><span class="song-number">${song.number ?? "–"}</span> ${escapeHtml(song.title)}
          <span class="admin-meta">${voices.length} ${voices.length === 1 ? "Stimme" : "Stimmen"}${done ? `, ${done} zugeordnet` : ""}</span></summary>
        <div class="assign-rows">
          ${voices.map((v) => {
            const saved = overrideLines(z[v.key]);
            // mindestens eine (leere) Zeile anzeigen; zusätzliche leere Zeilen aus dem Entwurf behalten
            const lines = state.assignExtra.get(v.key) ?? (saved.length ? saved : [{ inst: "", nr: "", st: "" }]);
            const now = displayVariantsWith(v.files[0], song, z).map((x) => x.label).join(" / ");
            return `
            <div class="assign-row${saved.length ? " is-set" : ""}" data-key="${escapeHtml(v.key)}">
              <div class="assign-name">
                <button class="voice-chip" data-open="${escapeHtml(v.files[0].id)}" type="button" title="Öffnen">Öffnen</button>
                <span><strong>${escapeHtml(v.base)}</strong>${v.files.length > 1 ? ` <span class="admin-meta">(${v.files.length} Seiten)</span>` : ""}
                  <span class="admin-meta">wird angezeigt als: ${escapeHtml(now)}</span></span>
              </div>
              <div class="assign-preview" data-preview="${escapeHtml(v.files[0].id)}">${previewCache.has(v.files[0].id)
                ? previewHtml(v.files[0].id) : `<span class="hint">Vorschau wird geladen …</span>`}</div>
              <div class="assign-lines">
                ${lines.map((l, i) => `
                  <div class="assign-fields" data-line="${i}">
                    <label class="field"><span>Instrument</span><select data-f="inst">${instOptions(l.inst)}</select></label>
                    <label class="field"><span>Stimme</span><select data-f="nr">${opts([1, 2, 3, 4, 5, 6], l.nr)}</select></label>
                    <label class="field"><span>Stimmung</span><select data-f="st">${opts(PITCH_OPTIONS, l.st)}</select></label>
                    <button class="chip-x assign-clear" type="button" data-remove-line="${i}" aria-label="Zeile entfernen" title="Zeile entfernen">×</button>
                  </div>`).join("")}
              </div>
              <button class="btn secondary small assign-add" type="button" data-add-line>+ Zeile</button>
            </div>`;
          }).join("")}
        </div>
      </details>`;
  }).join("") || `<p class="hint">${onlyUnclear ? "Keine unklaren Stimmen gefunden. Mit „Alle Stimmen“ kannst du auch andere korrigieren." : "Nichts gefunden."}</p>`;
}

// Bezeichnung mit einer bestimmten (z. B. noch ungespeicherten) Zuordnung berechnen
function displayVariantsWith(f, song, z) {
  const o = overrideFor(f, z);
  if (o) return overrideVariants(o, voiceBase(f.voice));
  const bases = [...new Set(song.files.map((x) => voiceBase(x.voice)))];
  return labelVariants(bases, { keepOriginal: isCollectionTitle(song.title) }).get(voiceBase(f.voice)) ?? [{ label: f.voice }];
}

// ---------- Vorschau-Streifen (oberer Rand der ersten Seite) ----------
const previewCache = new Map(); // fileId -> data-URL | "error"
const previewQueue = [];
const previewPending = new Set();
let previewRunning = 0;
const PREVIEW_PARALLEL = 3;

function previewHtml(id) {
  const v = previewCache.get(id);
  if (v === "error") return `<span class="hint">Keine Vorschau möglich.</span>`;
  return `<img src="${v}" alt="Oberer Rand des Notenblatts" />`;
}

function queuePreviews() {
  // nur sichtbare (aufgeklappte) Stücke laden
  document.querySelectorAll(".assign-song[open] [data-preview]").forEach((el) => {
    const id = el.dataset.preview;
    if (!previewCache.has(id) && !previewPending.has(id)) {
      previewPending.add(id);
      previewQueue.push(id);
    }
  });
  pumpPreviews();
}

function pumpPreviews() {
  while (previewRunning < PREVIEW_PARALLEL && previewQueue.length) {
    const id = previewQueue.shift();
    previewRunning++;
    (async () => {
      try {
        const blob = (await getPdfBlob(id)) ?? (await downloadPdf(id));
        previewCache.set(id, await renderPdfStrip(blob, 2.5, 700));
      } catch (err) {
        if (err instanceof NotLoggedInError) { previewQueue.length = 0; previewPending.clear(); handleError(err); return; }
        previewCache.set(id, "error");
      } finally {
        previewRunning--;
        previewPending.delete(id);
        document.querySelectorAll(`[data-preview="${CSS.escape(id)}"]`).forEach((el) => {
          if (previewCache.has(id)) el.innerHTML = previewHtml(id);
        });
        pumpPreviews();
      }
    })();
  }
}

function readLines(row) {
  return [...row.querySelectorAll(".assign-fields")].map((el) => ({
    inst: el.querySelector('[data-f="inst"]').value,
    nr: el.querySelector('[data-f="nr"]').value,
    st: el.querySelector('[data-f="st"]').value,
  }));
}

// Zeilen einer Stimme in den Entwurf übernehmen (leere Zeilen bleiben nur in der Anzeige)
function storeLines(row, lines) {
  const draft = ensureDraft();
  const key = row.dataset.key;
  const filled = lines.filter((l) => l.inst || l.nr || l.st);
  if (filled.length) draft.zuordnung[key] = { zeilen: filled };
  else delete draft.zuordnung[key];
  if (lines.length > filled.length || !lines.length) state.assignExtra.set(key, lines.length ? lines : [{ inst: "", nr: "", st: "" }]);
  else state.assignExtra.delete(key);
  renderAdmin();
}

function updateAssignment(row) {
  storeLines(row, readLines(row));
}

function setAll(active) {
  const draft = ensureDraft();
  const keys = adminItems().map((it) => it.key);
  if (state.adminMode === "instrumente") draft.instrumente = active ? new Set() : new Set(keys);
  else draft.stuecke = active ? new Set() : new Set(keys);
  renderAdmin();
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

async function saveAdmin(button) {
  button.disabled = true;
  try {
    // Schreibrecht nur für Dateien dieser App; beim ersten Mal fragt Google nach
    if (!canWrite()) await signIn({ interactive: true, withWrite: true });
    const draft = ensureDraft();
    const inaktiv = [...draft.stuecke];
    const instrumenteInaktiv = [...draft.instrumente];
    const zuordnung = sortKeys(draft.zuordnung);
    state.statusFileId = await saveStatus({
      ...CONFIG.STATUS_DATEI, fileId: state.statusFileId, inaktiv, instrumenteInaktiv, zuordnung, von: state.email,
    });
    state.inaktiv = new Set(inaktiv);
    state.instInaktiv = new Set(instrumenteInaktiv);
    setZuordnung(JSON.parse(JSON.stringify(zuordnung)));
    state.assignExtra.clear();
    state.statusInfo = { geaendert: new Date().toISOString(), von: state.email };
    cacheStatus();
    toast("Gespeichert. Alle sehen die Änderung beim nächsten Öffnen.");
    populateInstrumentFilter();
    populateStimmeFilter();
    renderSongs();
  } catch (err) {
    handleError(err);
  } finally {
    renderAdmin();
  }
}

// ---------- Anmeldung ----------

function updateLoginUi() {
  const signedIn = isSignedIn();
  $("#login-box").classList.toggle("hidden", signedIn);
  $("#logout-btn").classList.toggle("hidden", !signedIn);
}

async function handleLoginClick() {
  try {
    await signIn({ interactive: true });
    updateLoginUi();
    await Promise.all([refreshSongs(), checkAdmin()]);
    toast("Angemeldet");
  } catch (err) {
    toast(err.message, 4000);
  }
}

function handleError(err) {
  if (err instanceof NotLoggedInError) {
    updateLoginUi();
    $("#login-box").classList.remove("hidden");
    showView("search");
    toast("Bitte neu anmelden, um Noten aus Drive zu laden.", 4000);
    return;
  }
  toast(offlineHint(err), 4000);
}

// ---------- Ansichten ----------

function showView(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("is-active", t.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("is-active", v.id === `view-${name}`));
  if (name === "admin") renderAdmin();
  if (name === "print") renderPrint();
}

function populateInstrumentFilter() {
  const showInactive = $("#show-inactive-inst").checked;
  const all = allInstruments().map((i) => i.name);
  const visible = all.filter((name) => showInactive || isInstrumentActive(name));
  const hidden = all.length - visible.length;
  $("#inactive-inst-toggle").classList.toggle("hidden", all.every(isInstrumentActive));
  const n = all.filter((name) => !isInstrumentActive(name)).length;
  $("#inactive-inst-label").textContent = n === 1 ? "Auch 1 nicht aktives Instrument zeigen" : `Auch ${n} nicht aktive Instrumente zeigen`;

  const select = $("#voice-filter");
  const current = select.value || lsGet(LS_INSTRUMENT) || "";
  select.innerHTML = `<option value="">Alle Instrumente</option>`;
  for (const name of visible) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = isInstrumentActive(name) ? name : `${name} (nicht aktiv)`;
    select.append(opt);
  }
  select.value = visible.includes(current) ? current : "";
  populateStimmeFilter();
  return hidden;
}

function matchesSearch(song, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return song.title.toLowerCase().includes(q) || String(song.number ?? "") === q;
}

// Seiten-Dateien einer Stimme ("Trp 2 (S.1)", "Trp 2 (S.2)") erscheinen als EIN Knopf;
// der Betrachter lädt die weiteren Seiten automatisch mit.
const voiceBase = (label) => String(label).replace(/\s*\(S\.\d+\)/, "").trim();
const voicePage = (label) => Number(/\(S\.(\d+)\)/.exec(label)?.[1] ?? 0);

// Ausgeschriebene Bezeichnungen ("Trompete 1", "Horn 3/4 in Es · Part 4"), je Stück berechnet,
// weil die Stimmung nur gezeigt wird, wenn es dieselbe Stimme in mehreren Stimmungen gibt.
let labelCache = new Map();
let labelCacheFor = null;
let labelCacheZ = -1;

const niceInstrument = (name) => String(name).replace(" (frei besetzbar)", "");

// Bezeichnung aus einer Zuordnung: "Flügelhorn 1 in B", bei mehreren Instrumenten je eins
function overrideVariants(lines, base) {
  const part = parseVoice(base).part;
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    let label = l.inst ? niceInstrument(l.inst) : voiceBase(base);
    if (l.nr) label += ` ${l.nr}`;
    if (l.st) label += ` in ${l.st}`;
    if (part) label += ` · ${part}`;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, instrument: l.inst || null, nr: l.nr ? Number(l.nr) : null });
  }
  return out;
}

function labelsForFiles(files, title) {
  const bases = [...new Set(files.map((f) => voiceBase(f.voice)))];
  const isCollection = isCollectionTitle(title);
  const m = labelVariants(bases, { keepOriginal: isCollection });
  for (const f of files) {
    const o = overrideFor(f);
    labelCache.set(f.id, o ? overrideVariants(o, voiceBase(f.voice)) : m.get(voiceBase(f.voice)) ?? [{ label: f.voice, instrument: null }]);
  }
}

// Alle Bezeichnungen einer Datei (mehrere bei Stimmen für mehrere Instrumente)
function displayVariants(f) {
  if (labelCacheFor !== state.songs || labelCacheZ !== state.zVersion) {
    labelCache = new Map();
    labelCacheFor = state.songs;
    labelCacheZ = state.zVersion;
    for (const song of state.songs) labelsForFiles(song.files, song.title);
  }
  if (!labelCache.has(f.id)) {
    // offline gespeicherte Noten, deren Stück nicht in der Liste steht
    const e = state.offline.get(f.id);
    const same = e ? [...state.offline.values()].filter((x) => (x.songId ?? x.title) === (e.songId ?? e.title)) : [f];
    labelsForFiles(same, e?.title);
  }
  return labelCache.get(f.id) ?? [{ label: voiceBase(f.voice), instrument: null }];
}

const displayLabel = (f) => displayVariants(f).map((v) => v.label).join(" / ");

function groupVoices(files, all = false) {
  const groups = new Map();
  for (const f of files) {
    const key = voiceBase(f.voice);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  // Stimme für mehrere Instrumente: je Instrument ein eigener Knopf mit demselben Ziel.
  // Ist oben ein Instrument gewählt, nur der Knopf für dieses Instrument.
  const selected = all ? "" : document.querySelector("#voice-filter")?.value ?? "";
  const out = [];
  for (const [, list] of groups) {
    list.sort((a, b) => voicePage(a.voice) - voicePage(b.voice));
    const offline = list.every((f) => state.offline.has(f.id));
    let variants = displayVariants(list[0]);
    if (selected && variants.length > 1) {
      const mine = variants.filter((v) => v.instrument === selected);
      if (mine.length) variants = mine;
    }
    // ebenso bei gewählter Stimme nur die passende Zeile („Trompete 2“ statt auch „Trompete 1“)
    const stimmeSel = all ? "" : document.querySelector("#stimme-filter")?.value ?? "";
    if (stimmeSel && variants.length > 1) {
      const mine = variants.filter((v) => v.nr == null || v.nr === Number(stimmeSel));
      if (mine.length) variants = mine;
    }
    for (const v of variants) out.push({ label: v.label, first: list[0], files: list, offline });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, "de", { numeric: true }));
}

function voiceChips(files, cls = "voice-chip", labelFn = (g) => g.label, all = false) {
  return groupVoices(files, all).map((g) =>
    `<button class="${cls}" data-open="${escapeHtml(g.first.id)}" type="button" title="${escapeHtml(g.label)}${g.files.length > 1 ? ` (${g.files.length} Seiten)` : ""}">${escapeHtml(labelFn(g))}${g.offline ? " ✓" : ""}</button>`
  ).join("");
}

// Stücke als kompakte Tabelle wie in der Verwaltung. Der Schalter speichert die Stimmen offline.
const offlineEntry = (song, f) => ({
  id: f.id, songId: song.id, number: song.number, voice: f.voice, title: song.title, instruments: fileInstruments(f),
});

// Welche Stimmen ein Schalter betrifft: die gefilterten, sonst alle
function targetFiles(song) {
  const instrument = $("#voice-filter").value;
  const stimme = $("#stimme-filter").value;
  return instrument || stimme ? song.files.filter((f) => fileMatches(f, instrument, stimme)) : song.files;
}

// Offline gespeicherte Noten, deren Stück nicht (mehr) in der Liste steht, trotzdem zeigen
function offlineOnlySongs() {
  const known = new Set(state.songs.map((s) => s.id));
  const extra = new Map();
  for (const e of state.offline.values()) {
    if (known.has(e.songId)) continue;
    const key = e.songId ?? e.title;
    if (!extra.has(key)) extra.set(key, { id: key, number: e.number ?? null, title: e.title, files: [], orphan: true });
    extra.get(key).files.push(e);
  }
  return [...extra.values()];
}

function renderSongs() {
  const query = $("#search").value.trim();
  const instrument = $("#voice-filter").value;
  const stimme = $("#stimme-filter").value;
  const filtering = Boolean(instrument || stimme);
  const onlyOffline = $("#only-offline").checked;
  const showInactive = $("#show-inactive").checked;
  const hasOffline = (s) => s.files.some((f) => state.offline.has(f.id));

  const pool = onlyOffline ? [...state.songs, ...offlineOnlySongs()] : state.songs;
  const visible = pool
    .filter((s) => matchesSearch(s, query))
    .filter((s) => !filtering || s.files.some((f) => fileMatches(f, instrument, stimme)))
    .filter((s) => !onlyOffline || hasOffline(s))
    .filter((s) => onlyOffline || showInactive || isActive(s))
    .sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title, "de"));

  const hiddenCount = state.songs.filter((s) => !isActive(s)).length;
  $("#inactive-toggle").classList.toggle("hidden", hiddenCount === 0 || onlyOffline);
  $("#inactive-label").textContent = hiddenCount === 1 ? "Auch 1 nicht aktives Stück zeigen" : `Auch ${hiddenCount} nicht aktive Stücke zeigen`;

  const offCount = state.offline.size;
  const offBytes = [...state.offline.values()].reduce((sum, e) => sum + (e.size || 0), 0);
  $("#only-offline-label").textContent = offCount
    ? `Nur offline gespeicherte (${offCount} · ${formatBytes(offBytes)})`
    : "Nur offline gespeicherte (noch keine)";

  if (!state.loading) {
    $("#result-count").textContent = pool.length === 0
      ? "Noch keine Noten geladen."
      : visible.length === 1 ? "1 Stück gefunden" : `${visible.length} Stücke gefunden`;
  }
  $("#song-table").classList.toggle("hidden", visible.length === 0);

  // Haken für Solo-Stimmen nur zeigen, wenn es zur Auswahl welche gibt
  const soloCount = filtering
    ? pool.reduce((n, song) => n + groupVoices(song.files.filter((f) => isSolo(f) && (!instrument || fileHas(f, instrument)))).length, 0)
    : 0;
  $("#solo-toggle").classList.toggle("hidden", soloCount === 0);
  $("#solo-label").textContent = `Auch Solo-Stimmen zeigen (${soloCount})`;

  // Instrument und Stimme gewählt: alle angezeigten Stücke auf einmal offline speichern
  state.visibleSongs = visible;
  const bulk = $("#save-all-btn");
  const showBulk = Boolean(instrument && stimme) && visible.length > 0 && !onlyOffline;
  bulk.classList.toggle("hidden", !showBulk);
  if (showBulk && !state.bulkSaving) {
    const allTargets = visible.flatMap((song) => targetFiles(song));
    const missing = allTargets.filter((f) => !state.offline.has(f.id)).length;
    bulk.disabled = missing === 0;
    bulk.textContent = missing === 0
      ? "✓ Alle angezeigten Stücke sind offline"
      : `Alle herunterladen (${visible.length} ${visible.length === 1 ? "Stück" : "Stücke"}, ${missing} ${missing === 1 ? "Datei" : "Dateien"})`;
  }

  $("#song-list").innerHTML = visible.map((song) => {
    const target = song.orphan ? song.files : targetFiles(song);
    const offTarget = target.filter((f) => state.offline.has(f.id)).length;
    const offAll = song.files.filter((f) => state.offline.has(f.id)).length;
    const on = target.length > 0 && offTarget === target.length;
    const busy = state.saving.get(song.id);
    const open = state.expanded.has(song.id);

    const nVoices = new Set(song.files.map((f) => voiceBase(f.voice))).size;
    let meta = filtering ? groupVoices(target).map((g) => g.label).join(" · ") : `${nVoices} ${nVoices === 1 ? "Stimme" : "Stimmen"}`;
    if (busy) meta = busy;
    else if (offAll && !on) meta += ` · ${offAll} offline`;

    const chips = (files) => voiceChips(files);
    // Instrument und Stimme gewählt: Schnellbuttons direkt in der Zeile ("Seite 1", "Seite 2")
    const quick = instrument && stimme && !busy ? quickButtons(target) : "";
    const inactive = !song.orphan && !isActive(song);
    return `
      <tr class="song-row${inactive ? " is-inactive" : ""}${open ? " is-open" : ""}">
        <td class="num">${song.number ?? "–"}</td>
        <td class="song-cell" data-expand="${escapeHtml(song.id)}" role="button" tabindex="0" aria-expanded="${open}">
          <div class="song-line">
            <span class="song-name">${escapeHtml(song.title)}${inactive ? ` <span class="badge muted">nicht aktiv</span>` : ""}</span>
            ${quick}
          </div>
          ${quick ? "" : `<span class="admin-meta">${escapeHtml(meta)}</span>`}
        </td>
        <td class="switch-cell">
          <label class="switch">
            <input type="checkbox" data-offline-song="${escapeHtml(song.id)}" ${on ? "checked" : ""} ${busy ? "disabled" : ""} />
            <span class="slider" aria-hidden="true"></span>
            <span class="visually-hidden">${escapeHtml(song.title)} offline speichern</span>
          </label>
        </td>
      </tr>
      ${open ? `
      <tr class="voices-row">
        <td></td>
        <td colspan="2">
          <div class="voices">${chips(target)}</div>
          ${filtering && !song.orphan && target.length < song.files.length ? `
            <details class="all-voices">
              <summary>Alle Stimmen (${nVoices})</summary>
              <div class="voices">${voiceChips(song.files, "voice-chip", (g) => g.label, true)}</div>
            </details>` : ""}
        </td>
      </tr>` : ""}`;
  }).join("");
}

function quickButtons(files) {
  if (!files.length) return "";
  const single = groupVoices(files).length === 1;
  return `<span class="quick-row">${voiceChips(files, "voice-chip quick", (g) => (single ? "Öffnen" : g.label))}</span>`;
}

async function saveAllVisible() {
  if (state.bulkSaving) return;
  const songs = (state.visibleSongs ?? []).filter((s) => !s.orphan);
  const jobs = songs.flatMap((song) => targetFiles(song).filter((f) => !state.offline.has(f.id)).map((f) => offlineEntry(song, f)));
  if (!jobs.length) return;
  if (state.offline.size + jobs.length > MAX_OFFLINE_FILES) {
    toast(`Zu viele Dateien: Maximal ${MAX_OFFLINE_FILES} Noten offline (gerade ${state.offline.size}).`, 5000);
    return;
  }
  const btn = $("#save-all-btn");
  state.bulkSaving = true;
  btn.disabled = true;
  btn.classList.add("is-progress");
  btn.style.setProperty("--progress", "0%");
  let done = 0;
  try {
    for (const file of jobs) {
      btn.textContent = `Lade ${done + 1} von ${jobs.length} … ${Math.round((done / jobs.length) * 100)} %`;
      const blob = await downloadPdf(file.id);
      await savePdf(file, blob);
      done++;
      btn.style.setProperty("--progress", `${Math.round((done / jobs.length) * 100)}%`);
      if (done % 5 === 0) renderSongs();
    }
    toast(`${done} ${done === 1 ? "Datei" : "Dateien"} offline gespeichert`);
  } catch (err) {
    if (done) toast(`${done} von ${jobs.length} gespeichert, dann abgebrochen.`, 4000);
    handleError(err);
  } finally {
    state.bulkSaving = false;
    btn.classList.remove("is-progress");
    btn.style.removeProperty("--progress");
    renderSongs();
    updateStorageEstimate();
  }
}

async function toggleOffline(songId, wantOn) {
  const song = state.songs.find((s) => s.id === songId) ?? offlineOnlySongs().find((s) => s.id === songId);
  if (!song) return;
  const target = song.orphan ? song.files : targetFiles(song);
  if (!wantOn) {
    for (const f of target) if (state.offline.has(f.id)) await removePdf(f.id);
    toast(target.length === 1 ? "Vom Gerät entfernt" : "Stimmen vom Gerät entfernt");
    renderSongs();
    return;
  }
  const missing = target.filter((f) => !state.offline.has(f.id));
  if (missing.length > 8 && !confirm(`Alle ${missing.length} Stimmen von „${song.title}“ offline speichern?\nTipp: Erst oben dein Instrument wählen.`)) {
    renderSongs();
    return;
  }
  await saveFiles(song.id, missing.map((f) => offlineEntry(song, f)));
}

// ---------- Aktionen ----------

// Note im eingebauten Betrachter öffnen. Gehört die Datei zu einer Stimme mit mehreren Seiten-Dateien
// ("Trp 2 (S.1)", "Trp 2 (S.2)"), werden alle zusammen gezeigt und man kann durchblättern.

function openFile(fileId) {
  let song = state.songs.find((s) => s.files.some((f) => f.id === fileId));
  let files = song?.files;
  const entry = state.offline.get(fileId);
  if (!song && entry) {
    files = [...state.offline.values()].filter((e) => (e.songId ?? e.title) === (entry.songId ?? entry.title));
    song = { title: entry.title, number: entry.number };
  }
  const file = files?.find((f) => f.id === fileId) ?? { id: fileId, voice: entry?.voice ?? "" };
  const group = (files ?? [file])
    .filter((f) => voiceBase(f.voice) === voiceBase(file.voice))
    .sort((a, b) => voicePage(a.voice) - voicePage(b.voice));
  const title = song ? `${song.number != null ? song.number + " " : ""}${song.title}` : "Noten";
  openViewer({
    title,
    files: group.map((f) => ({ id: f.id, label: displayLabel(f) })),
    start: Math.max(0, group.findIndex((f) => f.id === fileId)),
    loadBlob: async (id) => (await getPdfBlob(id)) ?? (await downloadPdf(id)),
    // Zoom je Seite wird pro Nutzer auf diesem Gerät gemerkt
    reauth: async () => {
      await signIn({ interactive: true });
      updateLoginUi();
      checkAdmin();
    },
    zoomKey: `notenapp.zoom.${(state.email || lsGet(LS_USER) || "gast").toLowerCase()}`,
  }).catch(handleError);
}

async function saveFiles(songId, fileEntries) {
  let saved = 0;
  try {
    for (const file of fileEntries) {
      if (state.offline.has(file.id)) continue;
      if (state.offline.size >= MAX_OFFLINE_FILES) {
        toast(`Maximal ${MAX_OFFLINE_FILES} Noten offline. Bitte zuerst Noten entfernen.`, 4000);
        break;
      }
      state.saving.set(songId, `Speichere ${saved + 1} von ${fileEntries.length} …`);
      renderSongs();
      const blob = await downloadPdf(file.id);
      await savePdf(file, blob);
      saved++;
    }
    if (saved) toast(`${saved} ${saved === 1 ? "Datei" : "Dateien"} offline gespeichert`);
  } catch (err) {
    handleError(err);
  } finally {
    state.saving.delete(songId);
    renderSongs();
    updateStorageEstimate();
  }
}

function offlineHint(err) {
  if (!navigator.onLine) return "Keine Verbindung. Diese Note ist nicht offline gespeichert.";
  return err?.message ?? "Es ist ein Fehler aufgetreten.";
}

// ---------- Ereignisse ----------

function bindEvents() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => showView(t.dataset.view)));

  $("#search").addEventListener("input", renderSongs);
  $("#show-inactive").addEventListener("change", renderSongs);
  $("#admin-search").addEventListener("input", renderAdmin);
  $("#admin-filter").addEventListener("change", renderAdmin);
  $("#admin-save").addEventListener("click", (e) => saveAdmin(e.currentTarget));
  $("#admin-reset").addEventListener("click", () => { state.draft = null; state.assignExtra.clear(); renderAdmin(); });
  $("#admin-all-on").addEventListener("click", () => setAll(true));
  $("#admin-all-off").addEventListener("click", () => setAll(false));
  document.querySelectorAll("[data-admin-mode]").forEach((b) => b.addEventListener("click", () => {
    state.adminMode = b.dataset.adminMode;
    $("#admin-search").value = "";
    const sel = $("#admin-filter");
    if (state.adminMode !== "zuordnen" && sel.dataset.mode === "zuordnen") {
      sel.innerHTML = `<option value="alle">Alle Stücke</option><option value="aktiv">Nur aktive</option><option value="inaktiv">Nur nicht aktive</option>`;
      sel.dataset.mode = "";
    }
    sel.value = state.adminMode === "zuordnen" ? "unklar" : "alle";
    renderAdmin();
  }));
  $("#assign-list").addEventListener("change", (e) => {
    const row = e.target.closest(".assign-row");
    if (row && e.target.matches("select")) updateAssignment(row);
  });
  $("#assign-list").addEventListener("click", (e) => {
    const row = e.target.closest(".assign-row");
    if (!row) return;
    if (e.target.closest("[data-add-line]")) {
      const lines = readLines(row);
      const last = lines[lines.length - 1] ?? {};
      // neue Zeile: Stimmung der letzten übernehmen, das ist meist gleich
      storeLines(row, [...lines, { inst: "", nr: "", st: last.st ?? "" }]);
    }
    const rm = e.target.closest("[data-remove-line]");
    if (rm) {
      const lines = readLines(row);
      lines.splice(Number(rm.dataset.removeLine), 1);
      storeLines(row, lines);
    }
  });
  $("#assign-list").addEventListener("toggle", (e) => {
    const d = e.target.closest?.(".assign-song");
    if (!d) return;
    if (d.open) state.assignOpen.add(d.dataset.song); else state.assignOpen.delete(d.dataset.song);
    if (d.open) queuePreviews();
  }, true);
  $("#admin-list").addEventListener("change", (e) => {
    const box = e.target.closest("[data-toggle-key]");
    if (!box) return;
    const draft = ensureDraft();
    const set = state.adminMode === "instrumente" ? draft.instrumente : draft.stuecke;
    if (box.checked) set.delete(box.dataset.toggleKey);
    else set.add(box.dataset.toggleKey);
    renderAdmin();
  });
  $("#show-inactive-inst").addEventListener("change", () => { populateInstrumentFilter(); renderSongs(); });
  $("#voice-filter").addEventListener("change", () => {
    lsSet(LS_INSTRUMENT, $("#voice-filter").value);
    populateStimmeFilter();
    lsSet(LS_STIMME, $("#stimme-filter").value);
    renderSongs();
  });
  $("#stimme-filter").addEventListener("change", () => {
    lsSet(LS_STIMME, $("#stimme-filter").value);
    renderSongs();
  });
  $("#only-offline").addEventListener("change", renderSongs);
  $("#show-solo").checked = lsGet(LS_SOLO) === "1";
  $("#show-solo").addEventListener("change", () => {
    lsSet(LS_SOLO, $("#show-solo").checked ? "1" : "0");
    populateStimmeFilter();
    renderSongs();
  });
  $("#save-all-btn").addEventListener("click", saveAllVisible);
  $("#song-list").addEventListener("change", (e) => {
    const box = e.target.closest("[data-offline-song]");
    if (box) toggleOffline(box.dataset.offlineSong, box.checked);
  });
  const expand = (cell) => {
    const id = cell.dataset.expand;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    renderSongs();
  };
  $("#song-list").addEventListener("click", (e) => {
    if (e.target.closest("[data-open]")) return; // Schnellbutton öffnet nur die Note
    const c = e.target.closest("[data-expand]");
    if (c) expand(c);
  });
  $("#song-list").addEventListener("keydown", (e) => {
    const c = e.target.closest("[data-expand]");
    if (c && e.target === c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); expand(c); }
  });
  $("#login-btn").addEventListener("click", handleLoginClick);
  $("#logout-btn").addEventListener("click", () => {
    signOut();
    state.isAdmin = false;
    $("#tab-admin").classList.add("hidden");
    showView("search");
    updateLoginUi();
    toast("Abgemeldet. Offline gespeicherte Noten bleiben erhalten.");
  });
  $("#refresh-btn").addEventListener("click", () => refreshSongs().catch(handleError));

  // Klicks in Listen (Delegation)
  document.body.addEventListener("click", async (event) => {
    const openBtn = event.target.closest("[data-open]");
    if (openBtn) return openFile(openBtn.dataset.open);
  });
}

async function updateStorageEstimate() {
  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage && quota) {
      $("#only-offline-toggle").title = `Browser-Speicher: ${formatBytes(usage)} von ${formatBytes(quota)}`;
    }
  }
  // Browser bitten, die Offline-Noten nicht automatisch zu löschen
  navigator.storage?.persist?.().catch(() => {});
}

// ---------- Vollbild ----------
// Funktioniert in Chrome, Edge, Firefox und Safari auf iPad/Mac. Das iPhone kennt kein Vollbild für Webseiten:
// dort hilft „Zum Home-Bildschirm“, dann startet die App ohne Browserleiste. Der Knopf bleibt dort ausgeblendet.

const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement;
const fsSupported = () => Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);

async function toggleFullscreen() {
  try {
    if (fsElement()) {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    } else {
      const el = document.documentElement;
      await (el.requestFullscreen?.({ navigationUI: "hide" }) ?? el.webkitRequestFullscreen?.());
    }
  } catch {
    toast("Vollbild ist in diesem Browser nicht möglich.");
  }
}

function initFullscreen() {
  const btn = $("#fullscreen-btn");
  if (!fsSupported()) return;
  btn.classList.remove("hidden");
  btn.addEventListener("click", toggleFullscreen);
  const update = () => {
    const on = Boolean(fsElement());
    document.documentElement.classList.toggle("is-fullscreen", on);
    btn.setAttribute("aria-label", on ? "Vollbild beenden" : "Vollbild");
    btn.title = on ? "Vollbild beenden" : "Vollbild";
  };
  document.addEventListener("fullscreenchange", update);
  document.addEventListener("webkitfullscreenchange", update);
}

// ---------- Start ----------

async function init() {
  bindEvents();
  initFullscreen();
  initPrint({ getSongs: () => state.songs, isActive });
  try {
    await loadOfflineIndex();
  } catch (err) {
    toast("Offline-Speicher nicht verfügbar.", 4000);
  }

  // Zuletzt geladene Stückliste sofort zeigen (funktioniert auch ohne Internet)
  loadCachedSongs();
  loadCachedStatus();
  populateInstrumentFilter();
  renderSongs();
  updateStorageEstimate();
  updateLoginUi();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  if (!navigator.onLine) {
    if (state.offline.size) { $("#only-offline").checked = true; renderSongs(); }
    return;
  }

  try {
    await initAuth(CONFIG.GOOGLE_CLIENT_ID);
    // Kein automatisches Anmelden beim Start: Browser blockieren Google-Fenster ohne Klick.
    // Die zuletzt geladene Liste und offline gespeicherte Noten sind trotzdem sofort da.
  } catch (err) {
    updateLoginUi();
    toast(err.message, 5000);
  }
}

init();
