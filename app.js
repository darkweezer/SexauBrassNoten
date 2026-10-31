// Notenarchiv – Hauptlogik
// Stand: Grundgerüst. Login, Drive-Anbindung und Datenbank folgen (siehe README).

const DATA_URL = "data/songs.json";
const DB_NAME = "notenarchiv";
const DB_VERSION = 1;
const STORE_PDFS = "pdfs";      // key: fileId, value: { id, songId, voice, title, blob, savedAt }
const MAX_OFFLINE_FILES = 150;  // Obergrenze, damit der Gerätespeicher nicht überläuft

const state = {
  songs: [],        // [{ id, title, composer, files: [{ id, voice, url }] }]
  offline: new Map(), // fileId -> Eintrag aus IndexedDB (ohne Blob)
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

// ---------- Daten laden ----------

async function loadSongs() {
  // Später: Abfrage der Datenbank. Im Moment: lokale Beispieldatei.
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error("Notenliste konnte nicht geladen werden");
  const data = await res.json();
  state.songs = data.songs;
}

/**
 * Lädt die PDF-Datei eines Eintrags.
 * Platzhalter: Hier kommt später der Abruf über die Google Drive API (mit Login-Token) hinein.
 */
async function fetchPdf(file) {
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  return res.blob();
}

// ---------- Ansichten ----------

function showView(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("is-active", t.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("is-active", v.id === `view-${name}`));
  if (name === "offline") renderOffline();
}

function populateVoiceFilter() {
  const voices = new Set();
  state.songs.forEach((s) => s.files.forEach((f) => voices.add(f.voice)));
  const select = $("#voice-filter");
  [...voices].sort().forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.append(opt);
  });
}

function matchesSearch(song, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return song.title.toLowerCase().includes(q) || (song.composer ?? "").toLowerCase().includes(q);
}

function renderSongs() {
  const query = $("#search").value.trim();
  const voice = $("#voice-filter").value;

  const visible = state.songs
    .filter((s) => matchesSearch(s, query))
    .filter((s) => !voice || s.files.some((f) => f.voice === voice))
    .sort((a, b) => a.title.localeCompare(b.title, "de"));

  $("#result-count").textContent =
    visible.length === 1 ? "1 Stück gefunden" : `${visible.length} Stücke gefunden`;

  const list = $("#song-list");
  list.innerHTML = visible.map((song) => {
    const files = voice ? song.files.filter((f) => f.voice === voice) : song.files;
    return `
      <li class="song">
        <div>
          <div class="song-title">${escapeHtml(song.title)}</div>
          <div class="song-meta">${escapeHtml(song.composer ?? "")}</div>
        </div>
        <div class="voices">
          ${files.map((f) => {
            const off = state.offline.has(f.id);
            return `
              <span>
                <button class="voice-chip" data-open="${escapeHtml(f.id)}" type="button">
                  ${escapeHtml(f.voice)}${off ? " ✓" : ""}
                </button>
              </span>`;
          }).join("")}
        </div>
        <div class="song-actions">
          <button class="btn secondary" data-save-song="${escapeHtml(song.id)}" type="button">
            Alle Stimmen offline speichern
          </button>
        </div>
      </li>`;
  }).join("");
}

function renderOffline() {
  const entries = [...state.offline.values()].sort((a, b) => a.title.localeCompare(b.title, "de"));
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
  try {
    const offlineBlob = await getPdfBlob(fileId);
    const blob = offlineBlob ?? (await fetchPdf(findFile(fileId)));
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    toast(offlineHint(err));
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
      const blob = await fetchPdf(file);
      await savePdf(file, blob);
      saved++;
    }
    if (saved) toast(`${saved} ${saved === 1 ? "Datei" : "Dateien"} offline gespeichert`);
    else toast("Alles ist bereits offline verfügbar");
  } catch (err) {
    toast(offlineHint(err));
  } finally {
    if (button) button.disabled = false;
    renderSongs();
  }
}

function findFile(fileId) {
  for (const song of state.songs) {
    const f = song.files.find((x) => x.id === fileId);
    if (f) return { ...f, songId: song.id, title: `${song.title} – ${f.voice}` };
  }
  throw new Error("Datei nicht gefunden");
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
  $("#voice-filter").addEventListener("change", renderSongs);

  // Klicks in Listen (Delegation)
  document.body.addEventListener("click", async (event) => {
    const openBtn = event.target.closest("[data-open]");
    if (openBtn) return openFile(openBtn.dataset.open);

    const saveBtn = event.target.closest("[data-save-song]");
    if (saveBtn) {
      const song = state.songs.find((s) => s.id === saveBtn.dataset.saveSong);
      if (song) return saveFiles(song.files.map((f) => ({ ...f, songId: song.id, title: `${song.title} – ${f.voice}` })), saveBtn);
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
  // Ergänzend zur Anzeige: tatsächlicher Speicherbedarf des Browsers
  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    if (usage && quota) {
      $("#storage-info").title = `Browser-Speicher: ${formatBytes(usage)} von ${formatBytes(quota)}`;
    }
  }
}

// ---------- Start ----------

async function init() {
  bindEvents();
  try {
    await loadOfflineIndex();
    await loadSongs();
    populateVoiceFilter();
    renderSongs();
    updateStorageEstimate();
  } catch (err) {
    toast(err.message, 5000);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
