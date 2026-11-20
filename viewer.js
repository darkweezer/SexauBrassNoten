// NotenApp – eingebauter PDF-Betrachter
//
// Zeigt eine oder mehrere PDFs (z. B. "Seite 1" und "Seite 2" einer Stimme) als durchgehende Seitenfolge.
// Blättern: wischen, links/rechts auf den Rand tippen (auch im Zoom), Pfeiltasten oder Bluetooth-Fußpedal (Bild-ab/Leertaste).
// Zoomen: mit zwei Fingern aufziehen, Doppeltipp, die Knöpfe − / + oder Strg + Mausrad.
// Zoom und Ausschnitt werden je Seite und Nutzer auf dem Gerät gespeichert und beim nächsten Öffnen wiederhergestellt.
// Admins können mit „Zoom speichern“ den aktuellen Zoom einer Seite als Standard für alle festlegen (Status-Datei in Drive).
// Was neuer ist, gilt: ein später gespeicherter Standard ersetzt den eigenen Zoom, eigenes Zoomen danach ersetzt den Standard.
// „Drucken“ druckt alle Seiten der geöffneten Stimme (ganze Seiten, ohne Zoom).
// Die PDF-Bibliothek (pdf.js von Mozilla) liegt im Ordner vendor/pdfjs und funktioniert damit auch offline.
// Markieren (Stift-Knopf): eigene Kreise, Textmarker, Striche und Texte auf der Seite (siehe marks.js).
//   Im Markier-Modus zeichnet ein Finger, zwei Finger zoomen und verschieben. Die PDF selbst bleibt unverändert.

import { drawMarks, hitMark, roundPoint, MARK_COLORS, TEXT_SIZE } from "./marks.js";

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("./vendor/pdfjs/pdf.min.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

const $ = (sel, root = document) => root.querySelector(sel);
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const clamp = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
let current = null; // laufender Betrachter

// ---------- Zoom-Speicher (pro Nutzer, pro Datei und Seite) ----------

function loadZoomStore(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {}; } catch { return {}; }
}
function saveZoomStore(key, store) {
  try { localStorage.setItem(key, JSON.stringify(store)); } catch {}
}
const pageKey = (p) => `${p.fileId}:${p.num}`;
const roundView = (z, fx, fy) => ({ z: Math.round(z * 100) / 100, x: Math.round(fx * 1000) / 1000, y: Math.round(fy * 1000) / 1000 });
// gleiche Ansicht? (kleine Abweichungen durch andere Bildschirmgrößen zählen nicht)
const sameView = (a, b) => Math.abs((a?.z ?? 1) - (b?.z ?? 1)) < 0.02
  && ((a?.z ?? 1) <= 1.01 || (Math.abs((a?.x ?? 0.5) - (b?.x ?? 0.5)) < 0.02 && Math.abs((a?.y ?? 0) - (b?.y ?? 0)) < 0.02));

const ICON_PRINT = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/></svg>`;
const ICON_RESET = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/><path d="M8 10.5h5"/></svg>`;
const ICON_PEN = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/></svg>`;
const svg = (body) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const MARK_TOOLS = [
  { id: "c", label: "Kreis", icon: svg(`<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>`) },
  { id: "m", label: "Textmarker", icon: svg(`<path d="M3 17h12" stroke-width="5" opacity="0.45"/><path d="M14 4l5 5-7 7H7v-5z"/>`) },
  { id: "p", label: "Stift", icon: svg(`<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/>`) },
  { id: "t", label: "Text", icon: svg(`<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>`) },
  { id: "e", label: "Radierer", icon: svg(`<path d="M8 20h12"/><path d="M4.5 15.5l9.5-9.5 5 5-8 8H8z"/><path d="M9.5 10.5l5 5"/>`) },
];
const ICON_UNDO = svg(`<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>`);
const ICON_TRASH = svg(`<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>`);
const ICON_CLOUD = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z"/></svg>`;
const ICON_SAVE = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><rect x="7" y="13" width="10" height="8" rx="1"/></svg>`;

/**
 * @param {object} opts
 * @param {string} opts.title       Überschrift (Stückname)
 * @param {{id:string,label:string}[]} opts.files  Dateien in Reihenfolge
 * @param {number} opts.start       Index der Datei, mit der begonnen wird
 * @param {(id:string)=>Promise<Blob>} opts.loadBlob  lädt eine Datei (offline oder aus Drive)
 * @param {string} opts.zoomKey     localStorage-Schlüssel für die Zoom-Einstellungen dieses Nutzers
 * @param {()=>Promise<void>} [opts.reauth]  neu bei Google anmelden (muss aus einem Klick heraus laufen)
 * @param {()=>object} [opts.zoomDefaults]  Standard-Zoom aller Seiten: "<fileId>:<Seite>" -> { z, x, y, t }
 * @param {()=>boolean} [opts.canSaveZoom]  darf diese Person den Standard-Zoom speichern (Admin)?
 * @param {(key:string, view:object|null)=>Promise<boolean>} [opts.onSaveZoom]  Standard speichern (null = Standard entfernen)
 * @param {object|null} [opts.marks]  persönliche Markierungen dieser Person (createMarks aus marks.js)
 */
export async function openViewer({ title, files, start = 0, loadBlob, zoomKey = "notenapp.zoom", reauth,
  zoomDefaults = () => ({}), canSaveZoom = () => false, onSaveZoom, marks = null }) {
  closeViewer();
  const root = buildDom(title, Boolean(marks));
  const v = {
    root, files, loadBlob, zoomKey, reauth, start, zoomDefaults, canSaveZoom, onSaveZoom, title,
    zoomStore: loadZoomStore(zoomKey),
    pages: [],        // { fileIdx, fileId, doc, num, label }
    docs: new Map(),  // fileIdx -> PDFDocument
    index: 0,
    zoom: 1,
    renderTask: null,
    renderSeq: 0,
    blobs: new Map(),
    marks,
    editing: false,   // Markier-Modus an?
    tool: "c",
    colors: { c: "#e3241b", m: "#ffd400", p: "#e3241b", t: "#e3241b" },
    undo: [],         // { key, items } – Stand vor der Änderung
    drawing: null,    // gerade gezeichnete Markierung
  };
  current = v;
  history.pushState({ viewer: true }, "");
  bindControls(v);
  if (marks) bindMarks(v);
  watchBattery(v);
  await loadAll(v);
}

async function loadAll(v) {
  const { files, start, root } = v;
  setStatus(v, "Lade Noten …");
  $(".viewer-fallback", root).classList.add("hidden");
  $(".viewer-login", root).classList.add("hidden");
  v.loading = true;
  try {
    const lib = await loadPdfJs();
    // Startdatei zuerst, damit sofort etwas zu sehen ist; die anderen danach
    const order = [start, ...files.map((_, i) => i).filter((i) => i !== start)];
    for (const idx of order) {
      if (current !== v) return;
      if (v.docs.has(idx)) continue;
      const blob = await v.loadBlob(files[idx].id);
      v.blobs.set(idx, blob);
      const data = new Uint8Array(await blob.arrayBuffer());
      const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
      v.docs.set(idx, doc);
      insertPages(v, idx, doc);
      if (idx === start || v.pages.length === doc.numPages) {
        v.index = Math.max(0, v.pages.findIndex((p) => p.fileIdx === start));
        await showPage(v);
      } else {
        updateBar(v);
      }
    }
  } catch (err) {
    if (current !== v) return;
    if (err?.name === "NotLoggedInError" && v.reauth) {
      // Anmeldung abgelaufen: Knopf zeigen, der aus dem Klick heraus neu anmeldet und weiterlädt
      setStatus(v, v.pages.length ? "" : "Die Anmeldung bei Google ist abgelaufen.");
      $(".viewer-login", root).classList.remove("hidden");
      return;
    }
    console.error(err);
    if (!v.pages.length) {
      setStatus(v, err?.message ? `Die Noten konnten nicht angezeigt werden: ${err.message}` : "Die Noten konnten nicht angezeigt werden.");
      if (v.blobs.size) $(".viewer-fallback", root).classList.remove("hidden");
    }
  } finally {
    v.loading = false;
  }
}

export function closeViewer(fromHistory = false) {
  const v = current;
  if (!v) return;
  saveView(v);
  current = null;
  v.renderTask?.cancel();
  for (const doc of v.docs.values()) doc.destroy?.();
  window.removeEventListener("keydown", v.onKey);
  window.removeEventListener("resize", v.onResize);
  window.removeEventListener("popstate", v.onPop);
  v.stopBattery?.();
  v.stopMarks?.();
  v.marks?.flush();
  removePrintSheet();
  v.root.remove();
  document.body.classList.remove("viewer-open");
  if (!fromHistory && history.state?.viewer) history.back();
}

/* Akkustand des Geräts oben in der Leiste. Nur Chrome/Edge (auch Android) kennen
   navigator.getBattery(); Safari (iPhone/iPad) und Firefox nicht – dort bleibt die Anzeige weg.
   Am PC ohne Akku meldet Chrome „lädt, 100 %“ – auch dann blenden wir sie aus. */
async function watchBattery(v) {
  if (typeof navigator.getBattery !== "function") return;
  let bat;
  try { bat = await navigator.getBattery(); } catch { return; }
  if (current !== v) return;
  const el = $(".viewer-battery", v.root);
  const show = () => {
    const pct = Math.round(bat.level * 100);
    const noBattery = bat.charging && pct === 100 && bat.dischargingTime === Infinity && bat.chargingTime === 0;
    el.classList.toggle("hidden", noBattery);
    el.classList.toggle("is-low", !bat.charging && pct <= 20);
    el.classList.toggle("is-charging", bat.charging);
    const label = `Akku ${pct} %${bat.charging ? ", lädt" : ""}`;
    el.setAttribute("aria-label", label);
    el.title = label;
    el.innerHTML = batteryIcon(bat.level, bat.charging) + `<span>${pct} %</span>`;
  };
  show();
  const events = ["levelchange", "chargingchange", "chargingtimechange", "dischargingtimechange"];
  for (const e of events) bat.addEventListener(e, show);
  v.stopBattery = () => { for (const e of events) bat.removeEventListener(e, show); };
}

function batteryIcon(level, charging) {
  const w = Math.max(1, Math.round(15 * level));
  const bolt = charging ? `<path d="M11.5 7.5l-3 5h3l-1 4 3.5-5.5h-3l1-3.5z" fill="currentColor" stroke="none" class="bolt"/>` : "";
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10.5v3" stroke-linecap="round"/><rect x="3.5" y="8.5" width="${w}" height="7" rx="0.8" fill="currentColor" stroke="none" class="level"/>${bolt}</svg>`;
}

function insertPages(v, fileIdx, doc) {
  const { label, id: fileId } = v.files[fileIdx];
  const newPages = Array.from({ length: doc.numPages }, (_, i) => ({ fileIdx, fileId, doc, num: i + 1, label }));
  // nach Dateireihenfolge einsortieren, aktuelle Seite bleibt dieselbe
  const cur = v.pages[v.index];
  v.pages = [...v.pages, ...newPages].sort((a, b) => a.fileIdx - b.fileIdx || a.num - b.num);
  if (cur) v.index = v.pages.indexOf(cur);
}

function buildDom(title, withMarks) {
  const root = document.createElement("div");
  root.className = "viewer";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", `Noten: ${title}`);
  root.innerHTML = `
    <div class="viewer-bar">
      <div class="viewer-title"><strong></strong><span class="viewer-page"></span></div>
      <div class="viewer-tools">
      <button class="viewer-btn viewer-reset" type="button" aria-label="Zoom zurücksetzen (ganze Seite)" title="Zoom zurücksetzen (ganze Seite)" disabled>${ICON_RESET}</button>
      ${withMarks ? `<button class="viewer-btn viewer-mark" type="button" aria-label="Markieren" title="Markieren" aria-pressed="false" disabled>${ICON_PEN}</button>` : ""}
      <button class="viewer-btn viewer-save-zoom hidden" type="button" aria-label="Zoom dieser Seite als Standard für alle speichern" title="Zoom dieser Seite als Standard für alle speichern">${ICON_SAVE}</button>
      <span class="viewer-battery hidden" role="img"></span>
      <button class="viewer-btn viewer-print" type="button" aria-label="Drucken" title="Drucken" disabled>${ICON_PRINT}</button>
      <button class="viewer-btn viewer-zoom-out" type="button" aria-label="Verkleinern">−</button>
      <button class="viewer-btn viewer-zoom-in" type="button" aria-label="Vergrößern">+</button>
      <button class="viewer-btn viewer-close" type="button" aria-label="Schließen">✕</button>
      </div>
    </div>
    <div class="viewer-stage">
      <div class="viewer-inner"><div class="viewer-sheet"><canvas class="viewer-canvas"></canvas><canvas class="viewer-marks"></canvas></div></div>
      <p class="viewer-status"></p>
      <button class="btn secondary viewer-fallback hidden" type="button">Im Browser öffnen</button>
      <button class="btn viewer-login hidden" type="button">Neu anmelden</button>
    </div>
    <button class="viewer-nav prev" type="button" aria-label="Vorherige Seite"><span><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></span></button>
    ${withMarks ? markToolbar() : ""}
    <button class="viewer-nav next" type="button" aria-label="Nächste Seite"><span><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></span></button>
`;
  $(".viewer-title strong", root).textContent = title;
  document.body.append(root);
  document.body.classList.add("viewer-open");
  return root;
}

function setStatus(v, text) {
  const el = $(".viewer-status", v.root);
  el.textContent = text ?? "";
  el.classList.toggle("hidden", !text);
}

function updateBar(v) {
  const p = v.pages[v.index];
  const total = v.pages.length;
  const loading = v.docs.size < v.files.length ? " …" : "";
  const zoom = v.zoom > 1.01 ? ` · ${Math.round(v.zoom * 100)} %` : "";
  $(".viewer-page", v.root).textContent = p ? `${p.label} · ${v.index + 1} / ${total}${loading}${zoom}` : "";
  $(".viewer-nav.prev", v.root).disabled = v.index <= 0;
  $(".viewer-nav.next", v.root).disabled = v.index >= total - 1 && !loading;
  $(".viewer-zoom-out", v.root).disabled = v.zoom <= MIN_ZOOM + 0.01;
  $(".viewer-zoom-in", v.root).disabled = v.zoom >= MAX_ZOOM - 0.01;
  $(".viewer-reset", v.root).disabled = v.zoom <= 1.01;
  $(".viewer-print", v.root).disabled = !total || v.printing;
  const markBtn = $(".viewer-mark", v.root);
  if (markBtn) markBtn.disabled = !p;
  $(".viewer-save-zoom", v.root).classList.toggle("hidden", !v.canSaveZoom() || !p);
  v.root.classList.toggle("is-zoomed", v.zoom > 1.01);
}

// Ansicht, die beim Öffnen einer Seite gilt: eigener Zoom oder Standard-Zoom – was neuer ist
function effectiveView(v, key) {
  const own = v.zoomStore[key];
  const def = v.zoomDefaults()?.[key];
  if (def && (!own || (def.t ?? 0) > (own.t ?? 0))) return def;
  return own ?? null;
}

// Seite wechseln: gespeicherten Zoom und Ausschnitt dieser Seite holen
async function showPage(v) {
  const p = v.pages[v.index];
  if (!p) return;
  const saved = effectiveView(v, pageKey(p));
  v.zoom = clamp(saved?.z ?? 1);
  await render(v, { fx: saved?.x ?? 0.5, fy: saved?.y ?? 0 });
}

// Ausschnitt als Anteil (0 … 1) der möglichen Scrollweite
function scrollFraction(stage) {
  const maxX = stage.scrollWidth - stage.clientWidth;
  const maxY = stage.scrollHeight - stage.clientHeight;
  return { fx: maxX > 0 ? stage.scrollLeft / maxX : 0.5, fy: maxY > 0 ? stage.scrollTop / maxY : 0 };
}

function saveView(v) {
  const p = v.pages[v.index];
  if (!p) return;
  const key = pageKey(p);
  const view = currentView(v);
  const def = v.zoomDefaults()?.[key];
  const shown = effectiveView(v, key);
  if (shown && sameView(view, shown)) return; // nichts verändert
  if (def ? sameView(view, def) : view.z <= 1.01) {
    delete v.zoomStore[key]; // entspricht dem Standard
  } else {
    v.zoomStore[key] = { ...view, t: Date.now() }; // eigene Einstellung (auch „ganze Seite“ statt Standard-Zoom)
  }
  saveZoomStore(v.zoomKey, v.zoomStore);
}

function currentView(v) {
  if (v.zoom <= 1.01) return { z: 1 };
  const { fx, fy } = scrollFraction($(".viewer-stage", v.root));
  return roundView(v.zoom, fx, fy);
}

// Admin: aktuellen Zoom dieser Seite als Standard für alle speichern
async function saveDefaultZoom(v, button) {
  const p = v.pages[v.index];
  if (!p || !v.onSaveZoom) return;
  const key = pageKey(p);
  const view = currentView(v);
  button.disabled = true;
  try {
    const ok = await v.onSaveZoom(key, view.z <= 1.01 ? null : { ...view, t: Date.now() });
    if (ok && current === v) {
      delete v.zoomStore[key]; // eigener Zoom ist jetzt der Standard
      saveZoomStore(v.zoomKey, v.zoomStore);
    }
  } finally {
    button.disabled = false;
  }
}

// ---------- Markieren ----------
// Eigene Ebene (.viewer-marks) genau über der Notenseite. Positionen als Anteil der Seite (0 … 1).

function markToolbar() {
  const tools = MARK_TOOLS.map((t) =>
    `<button class="mt-btn mt-tool" type="button" data-tool="${t.id}" aria-label="${t.label}" title="${t.label}">${t.icon}<span>${t.label}</span></button>`).join("");
  const colors = MARK_COLORS.map((c) =>
    `<button class="mt-color" type="button" data-color="${c.value}" aria-label="Farbe ${c.label}" title="${c.label}" style="--c:${c.value}"></button>`).join("");
  return `
    <div class="viewer-marktools hidden" role="toolbar" aria-label="Markieren">
      <div class="mt-group">${tools}</div>
      <div class="mt-group mt-colors">${colors}</div>
      <div class="mt-group">
        <button class="mt-btn mt-undo" type="button" aria-label="Rückgängig" title="Rückgängig" disabled>${ICON_UNDO}<span>Zurück</span></button>
        <button class="mt-btn mt-clear" type="button" aria-label="Alle Markierungen dieser Seite löschen" title="Alle Markierungen dieser Seite löschen" disabled>${ICON_TRASH}<span>Seite leeren</span></button>
      </div>
      <button class="mt-sync" type="button"></button>
      <button class="btn mt-done" type="button">Fertig</button>
    </div>`;
}

const currentKey = (v) => { const p = v.pages[v.index]; return p ? pageKey(p) : null; };

function drawOverlay(v) {
  const overlay = $(".viewer-marks", v.root);
  if (!overlay || !v.marks || !v.cssW) return;
  const key = currentKey(v);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(v.cssW * dpr), h = Math.round(v.cssH * dpr);
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const items = key ? v.marks.get(key) : [];
  drawMarks(ctx, v.drawing ? [...items, v.drawing.item] : items, w, h);
  updateMarkButtons(v);
}

function updateMarkButtons(v) {
  const bar = $(".viewer-marktools", v.root);
  if (!bar) return;
  const key = currentKey(v);
  $(".mt-undo", bar).disabled = !v.undo.length;
  $(".mt-clear", bar).disabled = !key || !v.marks.get(key).length;
  const count = key ? v.marks.get(key).length : 0;
  $(".viewer-mark", v.root)?.classList.toggle("has-marks", count > 0);
}

function updateToolButtons(v) {
  const bar = $(".viewer-marktools", v.root);
  for (const b of bar.querySelectorAll(".mt-tool")) {
    const on = b.dataset.tool === v.tool;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  const color = v.colors[v.tool];
  for (const b of bar.querySelectorAll(".mt-color")) {
    const on = b.dataset.color === color;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  bar.querySelector(".mt-colors").classList.toggle("is-disabled", v.tool === "e");
}

function updateSyncButton(v) {
  const btn = $(".mt-sync", v.root);
  if (!btn || !v.marks) return;
  const st = v.marks.status();
  const texts = {
    aus: "Nur im Gerät – in Drive sichern?",
    bereit: "In Drive gesichert",
    laeuft: "Wird gesichert …",
    offline: "Offline – wird später gesichert",
    fehler: "Sichern fehlgeschlagen – erneut versuchen",
  };
  btn.innerHTML = `${ICON_CLOUD}<span>${texts[st] ?? ""}</span>`;
  btn.dataset.status = st;
  btn.disabled = st === "laeuft" || st === "bereit";
}

async function setEditing(v, on) {
  if (on === v.editing) return;
  v.editing = on;
  commitText(v);
  cancelDrawing(v);
  v.root.classList.toggle("is-editing", on);
  $(".viewer-marktools", v.root).classList.toggle("hidden", !on);
  const btn = $(".viewer-mark", v.root);
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", String(on));
  // Leiste unten nimmt Platz weg bzw. gibt ihn frei: Seite neu einpassen
  await render(v, scrollFraction($(".viewer-stage", v.root)));
  if (!on) v.marks.flush();
}

function cancelDrawing(v) {
  if (!v.drawing) return;
  v.drawing = null;
  drawOverlay(v);
}

function commitMarks(v, key, items) {
  v.undo.push({ key, items: v.marks.get(key) });
  if (v.undo.length > 100) v.undo.shift();
  v.marks.set(key, items);
  drawOverlay(v);
}

function undoMark(v) {
  const last = v.undo.pop();
  if (!last) return;
  v.marks.set(last.key, last.items);
  const idx = v.pages.findIndex((p) => pageKey(p) === last.key);
  if (idx >= 0 && idx !== v.index) { saveView(v); v.index = idx; showPage(v); }
  else drawOverlay(v);
}

// Punkt unter dem Finger/Mauszeiger als Anteil der Seite
function markPoint(v, e) {
  const r = $(".viewer-marks", v.root).getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function eraseAt(v, pt) {
  const key = currentKey(v);
  if (!key) return;
  const items = v.marks.get(key);
  const keep = items.filter((it) => !hitMark(it, pt.x, pt.y, v.cssW, v.cssH, 12));
  if (keep.length !== items.length) {
    if (!v.drawing.erased) { v.undo.push({ key, items }); v.drawing.erased = true; }
    v.marks.set(key, keep);
    drawOverlay(v);
  }
}

// Text: Eingabefeld direkt an der angetippten Stelle
function openTextInput(v, pt) {
  commitText(v);
  const key = currentKey(v);
  if (!key) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "viewer-textinput";
  input.placeholder = "Text …";
  input.maxLength = 60;
  input.enterKeyHint = "done";
  input.autocomplete = "off";
  input.style.left = `${pt.x * 100}%`;
  input.style.top = `${pt.y * 100}%`;
  input.style.fontSize = `${TEXT_SIZE * v.cssW}px`;
  input.style.color = v.colors.t;
  v.textInput = { input, key, pt, color: v.colors.t };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commitText(v); }
    else if (e.key === "Escape") { e.preventDefault(); commitText(v, true); }
  });
  input.addEventListener("blur", () => commitText(v));
  $(".viewer-sheet", v.root).append(input);
  input.focus({ preventScroll: true });
}

function commitText(v, cancel = false) {
  const t = v.textInput;
  if (!t) return;
  v.textInput = null;
  const text = t.input.value.trim();
  t.input.remove();
  if (cancel || !text) return;
  const [x, y] = roundPoint(t.pt.x, t.pt.y - TEXT_SIZE * (v.cssW / v.cssH) * 0.6);
  commitMarks(v, t.key, [...v.marks.get(t.key), { k: "t", c: t.color, x, y, s: text }]);
}

function bindMarks(v) {
  const root = v.root;
  const bar = $(".viewer-marktools", root);
  const overlay = $(".viewer-marks", root);

  $(".viewer-mark", root).addEventListener("click", async () => {
    const on = !v.editing;
    setEditing(v, on);
    // Beim ersten Mal fragen, ob die Markierungen auch im eigenen Drive gesichert werden sollen.
    // Das Google-Fenster muss direkt aus dem Klick heraus kommen.
    if (on && v.marks.syncChoice() == null) {
      v.marks.enableSync().catch(() => {}).finally(() => updateSyncButton(v));
    }
  });
  $(".mt-done", bar).addEventListener("click", () => setEditing(v, false));
  for (const b of bar.querySelectorAll(".mt-tool")) {
    b.addEventListener("click", () => { commitText(v); v.tool = b.dataset.tool; updateToolButtons(v); });
  }
  for (const b of bar.querySelectorAll(".mt-color")) {
    b.addEventListener("click", () => {
      if (v.tool === "e") return;
      v.colors[v.tool] = b.dataset.color;
      if (v.textInput) { v.textInput.color = b.dataset.color; v.textInput.input.style.color = b.dataset.color; v.textInput.input.focus(); }
      updateToolButtons(v);
    });
  }
  $(".mt-undo", bar).addEventListener("click", () => undoMark(v));
  const clearBtn = $(".mt-clear", bar);
  let clearTimer;
  clearBtn.addEventListener("click", () => {
    const key = currentKey(v);
    if (!key) return;
    // zweimal tippen, damit nichts aus Versehen verloren geht
    if (!clearBtn.classList.contains("is-confirm")) {
      clearBtn.classList.add("is-confirm");
      clearBtn.querySelector("span").textContent = "Wirklich?";
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => { clearBtn.classList.remove("is-confirm"); clearBtn.querySelector("span").textContent = "Seite leeren"; }, 3000);
      return;
    }
    clearTimeout(clearTimer);
    clearBtn.classList.remove("is-confirm");
    clearBtn.querySelector("span").textContent = "Seite leeren";
    commitMarks(v, key, []);
  });
  $(".mt-sync", bar).addEventListener("click", () => {
    v.marks.enableSync().catch(() => {}).finally(() => updateSyncButton(v));
  });

  overlay.addEventListener("pointerdown", (e) => {
    if (!v.editing || v.drawing || e.button > 0) return;
    const key = currentKey(v);
    if (!key) return;
    e.preventDefault();
    const pt = markPoint(v, e);
    if (v.tool === "t") {
      // erst nach dem Loslassen öffnen, sonst nimmt der Tipp dem Feld gleich wieder den Fokus
      const id = e.pointerId;
      const up = (ev) => { if (ev.pointerId === id) { overlay.removeEventListener("pointerup", up); openTextInput(v, pt); } };
      overlay.addEventListener("pointerup", up);
      return;
    }
    overlay.setPointerCapture?.(e.pointerId);
    commitText(v);
    const color = v.colors[v.tool];
    const [x, y] = roundPoint(pt.x, pt.y);
    if (v.tool === "e") {
      v.drawing = { id: e.pointerId, key, tool: "e", item: { k: "none" } };
      eraseAt(v, pt);
      return;
    }
    const item = v.tool === "c" ? { k: "c", c: color, x, y, w: 0, h: 0 } : { k: v.tool, c: color, p: [x, y] };
    v.drawing = { id: e.pointerId, key, tool: v.tool, item, start: { x, y }, lastPx: { x: e.clientX, y: e.clientY } };
    drawOverlay(v);
  });

  overlay.addEventListener("pointermove", (e) => {
    const d = v.drawing;
    if (!d || d.id !== e.pointerId) return;
    e.preventDefault();
    const pt = markPoint(v, e);
    if (d.tool === "e") { eraseAt(v, pt); return; }
    if (d.tool === "c") {
      const [x, y] = roundPoint(pt.x, pt.y);
      const r4 = (n) => Math.round(n * 10000) / 10000;
      d.item = { ...d.item, x: Math.min(x, d.start.x), y: Math.min(y, d.start.y), w: r4(Math.abs(x - d.start.x)), h: r4(Math.abs(y - d.start.y)) };
    } else {
      // nur alle paar Pixel einen Punkt speichern (kleinere Datei)
      if (Math.hypot(e.clientX - d.lastPx.x, e.clientY - d.lastPx.y) < 3) return;
      d.lastPx = { x: e.clientX, y: e.clientY };
      d.item.p.push(...roundPoint(pt.x, pt.y));
    }
    drawOverlay(v);
  });

  const finish = (e) => {
    const d = v.drawing;
    if (!d || d.id !== e.pointerId) return;
    v.drawing = null;
    if (d.tool === "e") { drawOverlay(v); return; }
    let item = d.item;
    if (item.k === "c" && Math.max(item.w * v.cssW, item.h * v.cssH) < 12) {
      // nur getippt: Kreis in Standardgröße um die Stelle
      const r = 0.035;
      const rh = r * (v.cssW / v.cssH);
      item = { ...item, x: Math.max(0, d.start.x - r), y: Math.max(0, d.start.y - rh), w: r * 2, h: rh * 2 };
      const [x, y] = roundPoint(item.x, item.y);
      item = { ...item, x, y, w: Math.round(item.w * 10000) / 10000, h: Math.round(item.h * 10000) / 10000 };
    }
    commitMarks(v, d.key, [...v.marks.get(d.key), item]);
  };
  overlay.addEventListener("pointerup", finish);
  overlay.addEventListener("pointercancel", (e) => { if (v.drawing?.id === e.pointerId) cancelDrawing(v); });

  // Abgleich mit Drive: Status anzeigen, neue Markierungen von anderen Geräten sofort zeigen
  v.stopMarks = v.marks.onChange((what) => {
    if (current !== v) return;
    if (what === "pages") drawOverlay(v);
    updateSyncButton(v);
  });
  updateToolButtons(v);
  updateSyncButton(v);
  v.marks.sync();
}

// ---------- Drucken ----------
// Alle Seiten der geöffneten Stimme als Bilder in einen eigenen Druckbereich zeichnen und den Druckdialog öffnen.
// Klappt so auch auf iPad und Android, wo man eine PDF in der Seite nicht direkt drucken kann.

function removePrintSheet() {
  document.querySelector(".sheet-print")?.remove();
  document.body.classList.remove("printing-sheet");
}

async function printSheets(v) {
  if (!v.pages.length || v.printing) return;
  v.printing = true;
  updateBar(v);
  const btn = $(".viewer-print", v.root);
  btn.classList.add("is-busy");
  try {
    // auf alle Dateien der Stimme warten (werden im Hintergrund geladen)
    while (v.loading && v.docs.size < v.files.length && current === v) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (current !== v) return;
    removePrintSheet();
    const sheet = document.createElement("div");
    sheet.className = "sheet-print";
    for (const p of v.pages) {
      const page = await p.doc.getPage(p.num);
      const base = page.getViewport({ scale: 1 });
      // etwa 200 dpi: scharf genug für Noten, aber nicht zu groß für Tablets
      const scale = Math.min(200 / 72, Math.sqrt(12e6 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (current !== v) return;
      const items = v.marks?.get(pageKey(p)) ?? [];
      if (items.length) {
        ctx.globalCompositeOperation = "multiply"; // Marker deckt die Noten nicht ab
        drawMarks(ctx, items, canvas.width, canvas.height);
        ctx.globalCompositeOperation = "source-over";
      }
      const img = new Image();
      img.alt = `${v.title} – ${p.label} – Seite ${p.num}`;
      img.className = base.width > base.height ? "is-landscape" : "";
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
      img.src = blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/jpeg", 0.9);
      canvas.width = canvas.height = 0;
      await img.decode().catch(() => {});
      const wrap = document.createElement("div");
      wrap.className = "sheet-print-page";
      wrap.append(img);
      sheet.append(wrap);
    }
    document.body.append(sheet);
    document.body.classList.add("printing-sheet");
    const cleanup = () => {
      window.removeEventListener("afterprint", cleanup);
      setTimeout(() => {
        for (const img of sheet.querySelectorAll("img")) if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
        sheet.remove();
        if (!document.querySelector(".sheet-print")) document.body.classList.remove("printing-sheet");
      }, 500);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  } catch (err) {
    console.error(err);
    setStatus(v, "Drucken hat nicht geklappt. Tipp: Datei über „Im Browser öffnen“ drucken.");
    setTimeout(() => current === v && setStatus(v, ""), 4000);
  } finally {
    v.printing = false;
    btn.classList.remove("is-busy");
    if (current === v) updateBar(v);
  }
}

/**
 * Zeichnet die aktuelle Seite. Position:
 *  - { fx, fy }: Ausschnitt als Anteil der Scrollweite
 *  - { anchor: { cx, cy, px, py } }: Inhaltspunkt (cx, cy als Anteil der Seite) soll an Bildschirmpunkt (px, py) bleiben
 */
async function render(v, pos = {}) {
  const p = v.pages[v.index];
  if (!p) return;
  const seq = ++v.renderSeq;
  updateBar(v);
  setStatus(v, "");
  const stage = $(".viewer-stage", v.root);
  const canvas = $(".viewer-canvas", v.root);
  const page = await p.doc.getPage(p.num);
  if (current !== v || seq !== v.renderSeq) return;

  const base = page.getViewport({ scale: 1 });
  const fit = Math.min(stage.clientWidth / base.width, stage.clientHeight / base.height);
  const scale = fit * v.zoom;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  // sehr große Zooms nicht in voller Auflösung zeichnen (Speicher auf Tablets)
  const maxPixels = 16e6;
  let renderScale = scale * dpr;
  const px = base.width * base.height * renderScale * renderScale;
  if (px > maxPixels) renderScale *= Math.sqrt(maxPixels / px);
  const viewport = page.getViewport({ scale: renderScale });

  v.renderTask?.cancel();
  const off = document.createElement("canvas");
  off.width = Math.floor(viewport.width);
  off.height = Math.floor(viewport.height);
  const task = page.render({ canvasContext: off.getContext("2d"), viewport });
  v.renderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name === "RenderingCancelledException") return;
    throw err;
  }
  if (current !== v || seq !== v.renderSeq) return;
  const cssW = Math.floor(base.width * scale);
  const cssH = Math.floor(base.height * scale);
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  $(".viewer-sheet", v.root).style.transform = "";
  canvas.getContext("2d").drawImage(off, 0, 0);
  v.cssW = cssW;
  v.cssH = cssH;
  drawOverlay(v);
  // Pfeile an den oberen Rand der Notenseite setzen (nicht in den grauen Bereich darüber)
  const stageTop = stage.getBoundingClientRect().top - v.root.getBoundingClientRect().top;
  const pageTop = Math.max(0, (stage.clientHeight - cssH) / 2);
  v.root.style.setProperty("--nav-top", `${Math.round(stageTop)}px`);
  v.root.style.setProperty("--page-top", `${Math.round(pageTop)}px`);

  // Ausschnitt setzen
  const maxX = Math.max(0, stage.scrollWidth - stage.clientWidth);
  const maxY = Math.max(0, stage.scrollHeight - stage.clientHeight);
  if (pos.anchor) {
    const { cx, cy, px: sx, py: sy } = pos.anchor;
    const offX = Math.max(0, (stage.clientWidth - cssW) / 2);
    const offY = Math.max(0, (stage.clientHeight - cssH) / 2);
    stage.scrollLeft = Math.min(maxX, Math.max(0, offX + cx * cssW - sx));
    stage.scrollTop = Math.min(maxY, Math.max(0, offY + cy * cssH - sy));
  } else {
    stage.scrollLeft = (pos.fx ?? 0.5) * maxX;
    stage.scrollTop = (pos.fy ?? 0) * maxY;
  }

  // nächste Seite schon vorbereiten
  const next = v.pages[v.index + 1];
  if (next) next.doc.getPage(next.num).catch(() => {});
}

// Inhaltspunkt unter einem Bildschirmpunkt (relativ zur Bühne) als Anteil der Seite
function contentPoint(v, sx, sy) {
  const stage = $(".viewer-stage", v.root);
  const canvas = $(".viewer-canvas", v.root);
  const r = canvas.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return {
    cx: Math.min(1, Math.max(0, (s.left + sx - r.left) / r.width)),
    cy: Math.min(1, Math.max(0, (s.top + sy - r.top) / r.height)),
    px: sx, py: sy,
  };
}

async function setZoom(v, zoom, sx, sy) {
  const stage = $(".viewer-stage", v.root);
  const z = clamp(zoom);
  if (Math.abs(z - v.zoom) < 0.01) return;
  const anchor = contentPoint(v, sx ?? stage.clientWidth / 2, sy ?? stage.clientHeight / 2);
  v.zoom = z;
  await render(v, { anchor });
  saveView(v);
}

function go(v, delta) {
  const target = v.index + delta;
  if (target < 0 || target >= v.pages.length) return;
  commitText(v);
  cancelDrawing(v);
  saveView(v);
  v.index = target;
  showPage(v);
}

function bindControls(v) {
  const root = v.root;
  const stage = $(".viewer-stage", root);
  const sheet = $(".viewer-sheet", root);

  $(".viewer-close", root).addEventListener("click", () => closeViewer());
  $(".viewer-nav.prev", root).addEventListener("click", () => go(v, -1));
  $(".viewer-nav.next", root).addEventListener("click", () => go(v, 1));
  $(".viewer-zoom-in", root).addEventListener("click", () => setZoom(v, v.zoom * 1.25));
  $(".viewer-zoom-out", root).addEventListener("click", () => setZoom(v, v.zoom / 1.25));
  $(".viewer-reset", root).addEventListener("click", () => setZoom(v, 1));
  $(".viewer-print", root).addEventListener("click", () => printSheets(v));
  $(".viewer-save-zoom", root).addEventListener("click", (e) => saveDefaultZoom(v, e.currentTarget));
  $(".viewer-login", root).addEventListener("click", async () => {
    try {
      await v.reauth();
    } catch (err) {
      setStatus(v, err?.message ?? "Anmeldung fehlgeschlagen.");
      return;
    }
    loadAll(v);
  });
  $(".viewer-fallback", root).addEventListener("click", () => {
    const blob = v.blobs.values().next().value;
    if (!blob) return;
    const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  });

  v.onKey = (e) => {
    if (e.target?.closest?.("input, textarea")) return; // Text wird gerade eingegeben
    if (e.key === "Escape" && v.editing) { setEditing(v, false); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && v.editing) { e.preventDefault(); undoMark(v); return; }
    if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); go(v, 1); }
    else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); go(v, -1); }
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && v.zoom <= 1.01) { e.preventDefault(); go(v, e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "+" || e.key === "=") setZoom(v, v.zoom * 1.25);
    else if (e.key === "-") setZoom(v, v.zoom / 1.25);
    else if (e.key === "0") setZoom(v, 1);
    else if (e.key === "Escape") closeViewer();
  };
  window.addEventListener("keydown", v.onKey);

  let resizeTimer;
  v.onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => render(v, scrollFraction(stage)), 150);
  };
  window.addEventListener("resize", v.onResize);

  // Zurück-Taste (Android) schließt den Betrachter
  v.onPop = () => closeViewer(true);
  window.addEventListener("popstate", v.onPop);

  // Ausschnitt nach dem Verschieben merken
  let scrollTimer;
  stage.addEventListener("scroll", () => {
    if (v.zoom <= 1.01) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => saveView(v), 300);
  }, { passive: true });

  // PC: Strg + Mausrad zoomt
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const s = stage.getBoundingClientRect();
    setZoom(v, v.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - s.left, e.clientY - s.top);
  }, { passive: false });

  // Doppeltipp/Doppelklick: auf 2,5-fach an dieser Stelle zoomen bzw. zurück
  const doubleTap = (clientX, clientY) => {
    const s = stage.getBoundingClientRect();
    setZoom(v, v.zoom > 1.01 ? 1 : 2.5, clientX - s.left, clientY - s.top);
  };
  stage.addEventListener("dblclick", (e) => { e.preventDefault(); if (!v.editing) doubleTap(e.clientX, e.clientY); });

  // Touch: Wischen (nur ohne Zoom), Zwei-Finger-Zoom und -Verschieben, Doppeltipp
  let t0 = null;      // Start eines Ein-Finger-Tipps/Wischens
  let pinch = null;   // laufender Zwei-Finger-Zoom
  let lastTap = 0;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  stage.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const s = stage.getBoundingClientRect();
      const mx = (a.clientX + b.clientX) / 2 - s.left;
      const my = (a.clientY + b.clientY) / 2 - s.top;
      const r = sheet.getBoundingClientRect();
      pinch = { d0: dist(a, b), zoom0: v.zoom, ratio: 1, mx, my, tx: 0, ty: 0, anchor: contentPoint(v, mx, my),
        ox: (a.clientX + b.clientX) / 2 - r.left, oy: (a.clientY + b.clientY) / 2 - r.top };
      sheet.style.transformOrigin = `${pinch.ox}px ${pinch.oy}px`;
      t0 = null;
      cancelDrawing(v); // zweiter Finger: das ist Zoomen, kein Zeichnen
      e.preventDefault();
    } else if (e.touches.length === 1 && !pinch) {
      // Scroll-Position merken: stand der Ausschnitt schon am Rand, darf ein Wischen auch im Zoom umblättern
      t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), left: stage.scrollLeft };
    }
  }, { passive: false });

  stage.addEventListener("touchmove", (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const target = clamp(pinch.zoom0 * (dist(a, b) / pinch.d0));
      pinch.ratio = target / pinch.zoom0;
      const s = stage.getBoundingClientRect();
      pinch.tx = (a.clientX + b.clientX) / 2 - s.left - pinch.mx;
      pinch.ty = (a.clientY + b.clientY) / 2 - s.top - pinch.my;
      // Vorschau, scharf gezeichnet wird beim Loslassen
      sheet.style.transform = `translate(${pinch.tx}px, ${pinch.ty}px) scale(${pinch.ratio})`;
    }
  }, { passive: false });

  stage.addEventListener("touchend", (e) => {
    if (pinch) {
      if (e.touches.length < 2) {
        const p = pinch;
        pinch = null;
        const z = clamp(p.zoom0 * p.ratio);
        if (Math.abs(z - v.zoom) < 0.01) {
          // nur verschoben
          sheet.style.transform = "";
          stage.scrollLeft -= p.tx;
          stage.scrollTop -= p.ty;
          return;
        }
        v.zoom = z;
        render(v, { anchor: { ...p.anchor, px: p.mx + p.tx, py: p.my + p.ty } }).then(() => saveView(v));
      }
      return;
    }
    if (v.editing) { t0 = null; return; } // im Markier-Modus nicht blättern
    if (!t0 || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    const quick = Date.now() - t0.t < 800;
    const start = t0;
    t0 = null;
    if (quick && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      // ohne Zoom immer; im Zoom nur, wenn der Ausschnitt in Wischrichtung schon am Rand war
      // (bzw. die Seite gar nicht seitlich verschiebbar ist) – sonst verschiebt das Wischen nur den Ausschnitt
      const maxX = stage.scrollWidth - stage.clientWidth;
      const atEdge = dx < 0 ? start.left >= maxX - 2 : start.left <= 2;
      if (v.zoom <= 1.01 || atEdge) {
        go(v, dx < 0 ? 1 : -1);
        return;
      }
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      // im Zoom: Tipp auf den linken/rechten Rand blättert um (wie ohne Zoom)
      if (v.zoom > 1.01) {
        const s = stage.getBoundingClientRect();
        const edge = Math.min(140, s.width * 0.18);
        const side = t.clientX - s.left < edge ? -1 : s.right - t.clientX < edge ? 1 : 0;
        if (side) { e.preventDefault(); lastTap = 0; go(v, side); return; }
      }
      const now = Date.now();
      if (now - lastTap < 300) { e.preventDefault(); doubleTap(t.clientX, t.clientY); lastTap = 0; }
      else lastTap = now;
    }
  });
}

/**
 * Kleine Vorschau: oberer Streifen der ersten Seite als Bild (für die Verwaltung „Zuordnen“).
 * @param {Blob} blob   PDF-Datei
 * @param {number} cm   Höhe des Streifens in cm (vom oberen Rand)
 * @param {number} cssWidth  gewünschte Breite in Bildschirmpixeln
 * @returns {Promise<string>} Bild als data-URL
 */
export async function renderPdfStrip(blob, cm = 2.5, cssWidth = 600) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = (cssWidth / base.width) * dpr;
    const viewport = page.getViewport({ scale });
    const stripPt = (cm / 2.54) * 72; // cm -> PDF-Punkte
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.max(1, Math.floor(Math.min(base.height, stripPt) * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise; // zeichnet nur, was auf die Leinwand passt
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    doc.destroy();
  }
}
