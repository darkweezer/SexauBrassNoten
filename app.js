// Notenarchiv – Hauptlogik
// Noten kommen live aus den zwei Google-Drive-Ordnern (siehe drive.js und config.js).
// Offline-Kopien liegen in IndexedDB auf dem Gerät.

import { CONFIG } from "./config.js";
import {
  initAuth, signIn, signOut, isSignedIn, wasSignedInBefore, canWrite,
  loadSongsFromDrive, downloadPdf, NotLoggedInError,
  getUserEmail, loadStatus, saveStatus,
} from "./drive.js";
import { INSTRUMENT_ORDER } from "./instruments.js";

const DB_NAME = "notenarchiv";
const DB_VERSION = 1;
const STORE_PDFS = "pdfs";      // key: fileId, value: { id, songId, voice, title, blob, savedAt }
const MAX_OFFLINE_FILES = 150;  // Obergrenze, damit der Gerätespeicher nicht überläuft
const LS_SONGS = "notenarchiv.stueckliste.v2"; // v2: Instrumente zusammengefasst
const LS_INSTRUMENT = "notenarchiv.instrument";
const LS_STATUS = "notenarchiv.inaktiv";

const state = {
  songs: [],          // [{ id, number, title, files: [{ id, name, voice, instrument, instruments, size }] }]
  offline: new Map(), // fileId -> Eintrag aus IndexedDB (ohne Blob)
  loading: false,
  inaktiv: new Set(), // Ordner-IDs der Stücke, die gerade nicht gespielt werden
  statusFileId: null,
  statusInfo: null,   // { geaendert, von }
  email: "",
  isAdmin: false,
  draft: null,        // Verwaltung: noch nicht gespeicherte Änderungen (Set)
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
const fileInstruments = (f) => f.instruments ?? [f.instrument];
const fileHas = (f, instrument) => fileInstruments(f).includes(instrument);

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

function loadCachedStatus() {
  try {
    const data = JSON.parse(lsGet(LS_STATUS) ?? "null");
    if (Array.isArray(data?.inaktiv)) state.inaktiv = new Set(data.inaktiv);
  } catch {}
}

async function refreshStatus() {
  try {
    const status = await loadStatus(CONFIG.STATUS_DATEI);
    // Entwurf in der Verwaltung nur verwerfen, wenn dort nichts ungespeichert ist
    if (state.draft && sameSet(state.draft, state.inaktiv)) state.draft = null;
    state.inaktiv = new Set(status.inaktiv);
    state.statusFileId = status.fileId;
    state.statusInfo = status.geaendert ? { geaendert: status.geaendert, von: status.von } : null;
    lsSet(LS_STATUS, JSON.stringify({ inaktiv: status.inaktiv }));
  } catch (err) {
    if (err instanceof NotLoggedInError) throw err;
    // ohne Status-Datei sind einfach alle Stücke aktiv
  }
}

const isActive = (song) => !state.inaktiv.has(song.id);

async function checkAdmin() {
  try {
    state.email = await getUserEmail();
  } catch { state.email = ""; }
  const admins = (CONFIG.VERWALTUNG ?? []).map((a) => a.toLowerCase().replace("@googlemail.com", "@gmail.com"));
  state.isAdmin = admins.includes(state.email.replace("@googlemail.com", "@gmail.com"));
  $("#tab-admin").classList.toggle("hidden", !state.isAdmin);
  if (state.isAdmin) renderAdmin();
}

// ---------- Verwaltung ----------

function renderAdmin() {
  if (!state.draft) state.draft = new Set(state.inaktiv);
  const query = $("#admin-search").value.trim();
  const filter = $("#admin-filter").value;
  const songs = [...state.songs]
    .sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title, "de"))
    .filter((s) => matchesSearch(s, query))
    .filter((s) => filter === "alle" || (filter === "aktiv") === !state.draft.has(s.id));

  const activeCount = state.songs.filter((s) => !state.draft.has(s.id)).length;
  $("#admin-count").textContent = `${activeCount} von ${state.songs.length} Stücken aktiv`;

  const changed = !sameSet(state.draft, state.inaktiv);
  $("#admin-save").disabled = !changed;
  $("#admin-unsaved").classList.toggle("hidden", !changed);
  const info = state.statusInfo;
  $("#admin-info").textContent = info
    ? `Zuletzt gespeichert am ${new Date(info.geaendert).toLocaleString("de-DE")} von ${info.von}`
    : "Noch nichts gespeichert: Alle Stücke gelten als aktiv.";

  $("#admin-list").innerHTML = songs.map((s) => {
    const active = !state.draft.has(s.id);
    return `
      <tr class="${active ? "" : "is-inactive"}">
        <td class="num">${s.number ?? "–"}</td>
        <td>${escapeHtml(s.title)}<span class="admin-meta">${s.files.length} Dateien</span></td>
        <td class="switch-cell">
          <label class="switch">
            <input type="checkbox" data-toggle-song="${escapeHtml(s.id)}" ${active ? "checked" : ""} />
            <span class="slider" aria-hidden="true"></span>
            <span class="visually-hidden">${escapeHtml(s.title)} aktiv</span>
          </label>
        </td>
      </tr>`;
  }).join("") || `<tr><td colspan="3" class="hint">Keine Stücke gefunden.</td></tr>`;
}

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
    const inaktiv = [...state.draft];
    state.statusFileId = await saveStatus({ ...CONFIG.STATUS_DATEI, fileId: state.statusFileId, inaktiv, von: state.email });
    state.inaktiv = new Set(inaktiv);
    state.statusInfo = { geaendert: new Date().toISOString(), von: state.email };
    lsSet(LS_STATUS, JSON.stringify({ inaktiv }));
    toast("Gespeichert. Alle sehen die Änderung beim nächsten Öffnen.");
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
  if (name === "offline") renderOffline();
  if (name === "admin") renderAdmin();
}

function populateInstrumentFilter() {
  const instruments = new Set();
  state.songs.forEach((s) => s.files.forEach((f) => fileInstruments(f).forEach((i) => instruments.add(i))));
  const select = $("#voice-filter");
  const current = select.value || lsGet(LS_INSTRUMENT) || "";
  select.innerHTML = `<option value="">Alle Instrumente</option>`;
  const rank = (name) => { const i = INSTRUMENT_ORDER.indexOf(name); return i < 0 ? 999 : i; };
  [...instruments].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "de")).forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.append(opt);
  });
  select.value = instruments.has(current) ? current : "";
}

function matchesSearch(song, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return song.title.toLowerCase().includes(q) || String(song.number ?? "") === q;
}

function voiceChip(f) {
  const off = state.offline.has(f.id);
  return `<button class="voice-chip" data-open="${escapeHtml(f.id)}" type="button">${escapeHtml(f.voice)}${off ? " ✓" : ""}</button>`;
}

function renderSongs() {
  const query = $("#search").value.trim();
  const instrument = $("#voice-filter").value;
  const showInactive = $("#show-inactive").checked;

  const visible = state.songs
    .filter((s) => matchesSearch(s, query))
    .filter((s) => !instrument || s.files.some((f) => fileHas(f, instrument)))
    .filter((s) => showInactive || isActive(s))
    .sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title, "de"));

  const hiddenCount = state.songs.filter((s) => !isActive(s)).length;
  $("#inactive-toggle").classList.toggle("hidden", hiddenCount === 0);
  $("#inactive-label").textContent = `Auch ${hiddenCount} nicht aktive Stücke zeigen`;

  if (!state.loading) {
    $("#result-count").textContent = state.songs.length === 0
      ? "Noch keine Noten geladen."
      : visible.length === 1 ? "1 Stück gefunden" : `${visible.length} Stücke gefunden`;
  }

  $("#song-list").innerHTML = visible.map((song) => {
    const mine = instrument ? song.files.filter((f) => fileHas(f, instrument)) : [];
    const number = song.number != null ? `<span class="song-number">${song.number}</span> ` : "";
    return `
      <li class="song${isActive(song) ? "" : " is-inactive"}">
        <div class="song-title">${number}${escapeHtml(song.title)}${isActive(song) ? "" : ` <span class="badge muted">nicht aktiv</span>`}</div>
        ${instrument ? `
          <div class="voices">${mine.map(voiceChip).join("")}</div>
          <div class="song-actions">
            <button class="btn secondary" data-save-song="${escapeHtml(song.id)}" type="button">
              ${mine.length === 1 ? "Offline speichern" : "Meine Stimmen offline speichern"}
            </button>
          </div>
          <details class="all-voices">
            <summary>Alle Stimmen (${song.files.length})</summary>
            <div class="voices">${song.files.map(voiceChip).join("")}</div>
          </details>` : `
          <details class="all-voices">
            <summary>Stimmen anzeigen (${song.files.length})</summary>
            <div class="voices">${song.files.map(voiceChip).join("")}</div>
          </details>`}
      </li>`;
  }).join("");
}

function renderOffline() {
  const entries = [...state.offline.values()];
  const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);

  $("#offline-empty").classList.toggle("hidden", entries.length > 0);
  $("#storage-info").textContent =
    `${entries.length} von ${MAX_OFFLINE_FILES} PDFs gespeichert · ${formatBytes(totalBytes)} belegt`;
  $("#storage-bar").style.width = `${Math.min(100, (entries.length / MAX_OFFLINE_FILES) * 100)}%`;

  // Stimmen desselben Stücks in einem Kasten zusammenfassen, wie bei „Noten“
  const groups = new Map();
  for (const e of entries) {
    const key = e.songId ?? e.title;
    if (!groups.has(key)) {
      const song = state.songs.find((s) => s.id === e.songId);
      groups.set(key, { songId: e.songId, title: song?.title ?? e.title, number: e.number ?? song?.number ?? null, files: [] });
    }
    groups.get(key).files.push(e);
  }
  const sorted = [...groups.values()].sort((a, b) =>
    (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title, "de"));

  $("#offline-list").innerHTML = sorted.map((g) => {
    const size = g.files.reduce((sum, e) => sum + (e.size || 0), 0);
    const number = g.number != null ? `<span class="song-number">${g.number}</span> ` : "";
    const files = g.files.sort((a, b) => a.voice.localeCompare(b.voice, "de", { numeric: true }));
    return `
      <li class="song">
        <div>
          <div class="song-title">${number}${escapeHtml(g.title)}</div>
          <div class="song-meta">${files.length === 1 ? "1 Stimme" : `${files.length} Stimmen`} · ${formatBytes(size)}</div>
        </div>
        <div class="voices">
          ${files.map((e) => `
            <span class="chip-group">
              <button class="voice-chip" data-open="${escapeHtml(e.id)}" type="button">${escapeHtml(e.voice)}</button>
              <button class="chip-x" data-remove="${escapeHtml(e.id)}" type="button" aria-label="${escapeHtml(e.voice)} vom Gerät entfernen">×</button>
            </span>`).join("")}
        </div>
        <div class="song-actions">
          <button class="btn danger small" data-remove-group="${escapeHtml(files.map((e) => e.id).join(","))}" type="button">Ganzes Stück vom Gerät entfernen</button>
        </div>
      </li>`;
  }).join("");
}

// ---------- Aktionen ----------

async function openFile(fileId) {
  // Fenster sofort im Klick öffnen, sonst blockieren iPhone und iPad es
  const win = window.open("", "_blank");
  try {
    const offlineBlob = await getPdfBlob(fileId);
    const blob = offlineBlob ?? (await downloadPdf(fileId));
    const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    if (win) win.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (err) {
    win?.close();
    handleError(err);
  }
}

async function saveFiles(fileEntries, button) {
  if (button) button.disabled = true;
  let saved = 0;
  try {
    for (const file of fileEntries) {
      if (state.offline.has(file.id)) continue;
      if (state.offline.size >= MAX_OFFLINE_FILES) {
        toast(`Maximal ${MAX_OFFLINE_FILES} Noten offline. Bitte zuerst Noten entfernen.`, 4000);
        break;
      }
      if (button) button.textContent = `Speichere ${saved + 1} von ${fileEntries.length} …`;
      const blob = await downloadPdf(file.id);
      await savePdf(file, blob);
      saved++;
    }
    if (saved) toast(`${saved} ${saved === 1 ? "Datei" : "Dateien"} offline gespeichert`);
    else toast("Alles ist bereits offline verfügbar");
  } catch (err) {
    handleError(err);
  } finally {
    if (button) button.disabled = false;
    renderSongs();
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
  $("#admin-reset").addEventListener("click", () => { state.draft = new Set(state.inaktiv); renderAdmin(); });
  $("#admin-all-on").addEventListener("click", () => { state.draft = new Set(); renderAdmin(); });
  $("#admin-all-off").addEventListener("click", () => { state.draft = new Set(state.songs.map((s) => s.id)); renderAdmin(); });
  $("#admin-list").addEventListener("change", (e) => {
    const box = e.target.closest("[data-toggle-song]");
    if (!box) return;
    if (box.checked) state.draft.delete(box.dataset.toggleSong);
    else state.draft.add(box.dataset.toggleSong);
    renderAdmin();
  });
  $("#voice-filter").addEventListener("change", () => {
    lsSet(LS_INSTRUMENT, $("#voice-filter").value);
    renderSongs();
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

    const saveBtn = event.target.closest("[data-save-song]");
    if (saveBtn) {
      const song = state.songs.find((s) => s.id === saveBtn.dataset.saveSong);
      const instrument = $("#voice-filter").value;
      if (song) {
        const files = song.files.filter((f) => !instrument || fileHas(f, instrument));
        return saveFiles(files.map((f) => ({ id: f.id, songId: song.id, number: song.number, voice: f.voice, title: song.title })), saveBtn);
      }
    }

    const removeGroup = event.target.closest("[data-remove-group]");
    if (removeGroup) {
      for (const id of removeGroup.dataset.removeGroup.split(",")) await removePdf(id);
      toast("Stück vom Gerät entfernt");
      renderOffline();
      renderSongs();
      return;
    }

    const removeBtn = event.target.closest("[data-remove]");
    if (removeBtn) {
      await removePdf(removeBtn.dataset.remove);
      toast("Vom Gerät entfernt");
      renderOffline();
      renderSongs();
    }
  });
}

async function updateStorageEstimate() {
  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage && quota) {
      $("#storage-info").title = `Browser-Speicher: ${formatBytes(usage)} von ${formatBytes(quota)}`;
    }
  }
  // Browser bitten, die Offline-Noten nicht automatisch zu löschen
  navigator.storage?.persist?.().catch(() => {});
}

// ---------- Start ----------

async function init() {
  bindEvents();
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
    if (state.offline.size) showView("offline");
    return;
  }

  try {
    await initAuth(CONFIG.GOOGLE_CLIENT_ID);
    if (wasSignedInBefore()) {
      // still neu anmelden; wenn das nicht klappt, erscheint der Anmelde-Knopf
      await signIn({ interactive: false });
      updateLoginUi();
      await Promise.all([refreshSongs(), checkAdmin()]);
    }
  } catch (err) {
    updateLoginUi();
    if (!(err instanceof NotLoggedInError) && !/abgebrochen|nicht möglich/.test(err.message)) {
      toast(err.message, 4000);
    }
  }
}

init();
