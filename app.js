// Notenarchiv – Hauptlogik
// Noten kommen live aus den zwei Google-Drive-Ordnern (siehe drive.js und config.js).
// Offline-Kopien liegen in IndexedDB auf dem Gerät.

import { CONFIG } from "./config.js";
import {
  initAuth, signIn, signOut, isSignedIn, wasSignedInBefore,
  loadSongsFromDrive, downloadPdf, NotLoggedInError,
} from "./drive.js";

const DB_NAME = "notenarchiv";
const DB_VERSION = 1;
const STORE_PDFS = "pdfs";      // key: fileId, value: { id, songId, voice, title, blob, savedAt }
const MAX_OFFLINE_FILES = 150;  // Obergrenze, damit der Gerätespeicher nicht überläuft
const LS_SONGS = "notenarchiv.stueckliste";
const LS_INSTRUMENT = "notenarchiv.instrument";

const state = {
  songs: [],          // [{ id, number, title, files: [{ id, name, voice, instrument, size }] }]
  offline: new Map(), // fileId -> Eintrag aus IndexedDB (ohne Blob)
  loading: false,
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
  try {
    state.songs = await loadSongsFromDrive(CONFIG.NOTEN_ORDNER);
    lsSet(LS_SONGS, JSON.stringify({ loadedAt: Date.now(), songs: state.songs }));
  } finally {
    state.loading = false;
  }
  populateInstrumentFilter();
  renderSongs();
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
    await refreshSongs();
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
}

function populateInstrumentFilter() {
  const instruments = new Set();
  state.songs.forEach((s) => s.files.forEach((f) => instruments.add(f.instrument)));
  const select = $("#voice-filter");
  const current = select.value || lsGet(LS_INSTRUMENT) || "";
  select.innerHTML = `<option value="">Alle Instrumente</option>`;
  [...instruments].sort((a, b) => a.localeCompare(b, "de")).forEach((v) => {
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

  const visible = state.songs
    .filter((s) => matchesSearch(s, query))
    .filter((s) => !instrument || s.files.some((f) => f.instrument === instrument))
    .sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title, "de"));

  if (!state.loading) {
    $("#result-count").textContent = state.songs.length === 0
      ? "Noch keine Noten geladen."
      : visible.length === 1 ? "1 Stück gefunden" : `${visible.length} Stücke gefunden`;
  }

  $("#song-list").innerHTML = visible.map((song) => {
    const mine = instrument ? song.files.filter((f) => f.instrument === instrument) : [];
    const number = song.number != null ? `<span class="song-number">${song.number}</span> ` : "";
    return `
      <li class="song">
        <div class="song-title">${number}${escapeHtml(song.title)}</div>
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
  const entries = [...state.offline.values()].sort((a, b) =>
    a.title.localeCompare(b.title, "de") || a.voice.localeCompare(b.voice, "de", { numeric: true }));
  const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);

  $("#offline-empty").classList.toggle("hidden", entries.length > 0);
  $("#storage-info").textContent =
    `${entries.length} von ${MAX_OFFLINE_FILES} PDFs gespeichert · ${formatBytes(totalBytes)} belegt`;
  $("#storage-bar").style.width = `${Math.min(100, (entries.length / MAX_OFFLINE_FILES) * 100)}%`;

  $("#offline-list").innerHTML = entries.map((e) => `
    <li class="song">
      <div>
        <div class="song-title">${escapeHtml(e.title)}</div>
        <div class="song-meta">${escapeHtml(e.voice)} · ${formatBytes(e.size)}</div>
      </div>
      <div class="song-actions">
        <button class="btn" data-open="${escapeHtml(e.id)}" type="button">Öffnen</button>
        <button class="btn danger" data-remove="${escapeHtml(e.id)}" type="button">Vom Gerät entfernen</button>
      </div>
    </li>`).join("");
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
  $("#voice-filter").addEventListener("change", () => {
    lsSet(LS_INSTRUMENT, $("#voice-filter").value);
    renderSongs();
  });
  $("#login-btn").addEventListener("click", handleLoginClick);
  $("#logout-btn").addEventListener("click", () => {
    signOut();
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
        const files = song.files.filter((f) => !instrument || f.instrument === instrument);
        return saveFiles(files.map((f) => ({ id: f.id, songId: song.id, voice: f.voice, title: song.title })), saveBtn);
      }
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
      await refreshSongs();
    }
  } catch (err) {
    updateLoginUi();
    if (!(err instanceof NotLoggedInError) && !/abgebrochen|nicht möglich/.test(err.message)) {
      toast(err.message, 4000);
    }
  }
}

init();
