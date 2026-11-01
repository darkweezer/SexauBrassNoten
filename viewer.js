// NotenApp – eingebauter PDF-Betrachter
//
// Zeigt eine oder mehrere PDFs (z. B. "Seite 1" und "Seite 2" einer Stimme) als durchgehende Seitenfolge.
// Blättern: wischen, links/rechts auf den Rand tippen, Pfeiltasten oder Bluetooth-Fußpedal (Bild-ab/Leertaste).
// Zoomen: mit zwei Fingern aufziehen, Doppeltipp, die Knöpfe − / + oder Strg + Mausrad.
// Zoom und Ausschnitt werden je Seite und Nutzer auf dem Gerät gespeichert und beim nächsten Öffnen wiederhergestellt.
// Die PDF-Bibliothek (pdf.js von Mozilla) liegt im Ordner vendor/pdfjs und funktioniert damit auch offline.

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

/**
 * @param {object} opts
 * @param {string} opts.title       Überschrift (Stückname)
 * @param {{id:string,label:string}[]} opts.files  Dateien in Reihenfolge
 * @param {number} opts.start       Index der Datei, mit der begonnen wird
 * @param {(id:string)=>Promise<Blob>} opts.loadBlob  lädt eine Datei (offline oder aus Drive)
 * @param {string} opts.zoomKey     localStorage-Schlüssel für die Zoom-Einstellungen dieses Nutzers
 * @param {()=>Promise<void>} [opts.reauth]  neu bei Google anmelden (muss aus einem Klick heraus laufen)
 */
export async function openViewer({ title, files, start = 0, loadBlob, zoomKey = "notenapp.zoom", reauth }) {
  closeViewer();
  const root = buildDom(title);
  const v = {
    root, files, loadBlob, zoomKey, reauth, start,
    zoomStore: loadZoomStore(zoomKey),
    pages: [],        // { fileIdx, fileId, doc, num, label }
    docs: new Map(),  // fileIdx -> PDFDocument
    index: 0,
    zoom: 1,
    renderTask: null,
    renderSeq: 0,
    blobs: new Map(),
  };
  current = v;
  history.pushState({ viewer: true }, "");
  bindControls(v);
  await loadAll(v);
}

async function loadAll(v) {
  const { files, start, root } = v;
  setStatus(v, "Lade Noten …");
  $(".viewer-fallback", root).classList.add("hidden");
  $(".viewer-login", root).classList.add("hidden");
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
  v.root.remove();
  document.body.classList.remove("viewer-open");
  if (!fromHistory && history.state?.viewer) history.back();
}

function insertPages(v, fileIdx, doc) {
  const { label, id: fileId } = v.files[fileIdx];
  const newPages = Array.from({ length: doc.numPages }, (_, i) => ({ fileIdx, fileId, doc, num: i + 1, label }));
  // nach Dateireihenfolge einsortieren, aktuelle Seite bleibt dieselbe
  const cur = v.pages[v.index];
  v.pages = [...v.pages, ...newPages].sort((a, b) => a.fileIdx - b.fileIdx || a.num - b.num);
  if (cur) v.index = v.pages.indexOf(cur);
}

function buildDom(title) {
  const root = document.createElement("div");
  root.className = "viewer";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", `Noten: ${title}`);
  root.innerHTML = `
    <div class="viewer-bar">
      <div class="viewer-title"><strong></strong><span class="viewer-page"></span></div>
      <button class="viewer-reset is-off" type="button" aria-label="Zoom zurücksetzen">↺ Zoom</button>
      <div class="viewer-tools">
      <button class="viewer-btn viewer-zoom-out" type="button" aria-label="Verkleinern">−</button>
      <button class="viewer-btn viewer-zoom-in" type="button" aria-label="Vergrößern">+</button>
      <button class="viewer-btn viewer-close" type="button" aria-label="Schließen">✕</button>
      </div>
    </div>
    <div class="viewer-stage">
      <div class="viewer-inner"><canvas class="viewer-canvas"></canvas></div>
      <p class="viewer-status"></p>
      <button class="btn secondary viewer-fallback hidden" type="button">Im Browser öffnen</button>
      <button class="btn viewer-login hidden" type="button">Neu anmelden</button>
    </div>
    <button class="viewer-nav prev" type="button" aria-label="Vorherige Seite"><span>‹</span></button>
    <button class="viewer-nav next" type="button" aria-label="Nächste Seite"><span>›</span></button>
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
  $(".viewer-reset", v.root).classList.toggle("is-off", v.zoom <= 1.01);
  v.root.classList.toggle("is-zoomed", v.zoom > 1.01);
}

// Seite wechseln: gespeicherten Zoom und Ausschnitt dieser Seite holen
async function showPage(v) {
  const p = v.pages[v.index];
  if (!p) return;
  const saved = v.zoomStore[pageKey(p)];
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
  if (v.zoom <= 1.01) {
    delete v.zoomStore[key];
  } else {
    const { fx, fy } = scrollFraction($(".viewer-stage", v.root));
    v.zoomStore[key] = { z: Math.round(v.zoom * 100) / 100, x: Math.round(fx * 1000) / 1000, y: Math.round(fy * 1000) / 1000 };
  }
  saveZoomStore(v.zoomKey, v.zoomStore);
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
  canvas.style.transform = "";
  canvas.getContext("2d").drawImage(off, 0, 0);

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
  saveView(v);
  v.index = target;
  showPage(v);
}

function bindControls(v) {
  const root = v.root;
  const stage = $(".viewer-stage", root);
  const canvas = $(".viewer-canvas", root);

  $(".viewer-close", root).addEventListener("click", () => closeViewer());
  $(".viewer-nav.prev", root).addEventListener("click", () => go(v, -1));
  $(".viewer-nav.next", root).addEventListener("click", () => go(v, 1));
  $(".viewer-zoom-in", root).addEventListener("click", () => setZoom(v, v.zoom * 1.25));
  $(".viewer-zoom-out", root).addEventListener("click", () => setZoom(v, v.zoom / 1.25));
  $(".viewer-reset", root).addEventListener("click", () => setZoom(v, 1));
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
  stage.addEventListener("dblclick", (e) => { e.preventDefault(); doubleTap(e.clientX, e.clientY); });

  // Touch: Wischen (nur ohne Zoom), Zwei-Finger-Zoom, Doppeltipp
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
      const r = canvas.getBoundingClientRect();
      pinch = { d0: dist(a, b), zoom0: v.zoom, ratio: 1, mx, my, anchor: contentPoint(v, mx, my),
        ox: (a.clientX + b.clientX) / 2 - r.left, oy: (a.clientY + b.clientY) / 2 - r.top };
      canvas.style.transformOrigin = `${pinch.ox}px ${pinch.oy}px`;
      t0 = null;
      e.preventDefault();
    } else if (e.touches.length === 1 && !pinch) {
      t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    }
  }, { passive: false });

  stage.addEventListener("touchmove", (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const target = clamp(pinch.zoom0 * (dist(a, b) / pinch.d0));
      pinch.ratio = target / pinch.zoom0;
      canvas.style.transform = `scale(${pinch.ratio})`; // Vorschau, scharf gezeichnet wird beim Loslassen
    }
  }, { passive: false });

  stage.addEventListener("touchend", (e) => {
    if (pinch) {
      if (e.touches.length < 2) {
        const p = pinch;
        pinch = null;
        const z = clamp(p.zoom0 * p.ratio);
        if (Math.abs(z - v.zoom) < 0.01) { canvas.style.transform = ""; return; }
        v.zoom = z;
        render(v, { anchor: p.anchor }).then(() => saveView(v));
      }
      return;
    }
    if (!t0 || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    const quick = Date.now() - t0.t < 800;
    t0 = null;
    if (v.zoom <= 1.01 && quick && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      go(v, dx < 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
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
