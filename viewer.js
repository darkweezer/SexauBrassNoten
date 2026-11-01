// NotenApp – eingebauter PDF-Betrachter
//
// Zeigt eine oder mehrere PDFs (z. B. "Seite 1" und "Seite 2" einer Stimme) als durchgehende Seitenfolge.
// Blättern: wischen, links/rechts auf den Rand tippen, Pfeiltasten oder Bluetooth-Fußpedal (Bild-ab/Leertaste).
// Doppeltipp: zwischen „ganze Seite“ und „Seitenbreite“ umschalten.
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
let current = null; // laufender Betrachter

/**
 * @param {object} opts
 * @param {string} opts.title       Überschrift (Stückname)
 * @param {{id:string,label:string}[]} opts.files  Dateien in Reihenfolge
 * @param {number} opts.start       Index der Datei, mit der begonnen wird
 * @param {(id:string)=>Promise<Blob>} opts.loadBlob  lädt eine Datei (offline oder aus Drive)
 */
export async function openViewer({ title, files, start = 0, loadBlob }) {
  closeViewer();
  const root = buildDom(title);
  const v = {
    root, files, loadBlob,
    pages: [],        // { fileIdx, doc, num, label }
    docs: new Map(),  // fileIdx -> Promise<PDFDocument>
    index: 0,
    fitWidth: false,
    renderTask: null,
    blobs: new Map(),
  };
  current = v;
  history.pushState({ viewer: true }, "");
  bindControls(v);
  setStatus(v, "Lade Noten …");

  try {
    const lib = await loadPdfJs();
    // Startdatei zuerst, damit sofort etwas zu sehen ist; die anderen danach
    const order = [start, ...files.map((_, i) => i).filter((i) => i !== start)];
    for (const idx of order) {
      if (current !== v) return;
      const blob = await loadBlob(files[idx].id);
      v.blobs.set(idx, blob);
      const data = new Uint8Array(await blob.arrayBuffer());
      const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
      v.docs.set(idx, doc);
      insertPages(v, idx, doc);
      if (idx === start) {
        v.index = v.pages.findIndex((p) => p.fileIdx === start);
        await render(v);
      } else {
        updateBar(v);
      }
    }
  } catch (err) {
    if (current !== v) return;
    console.error(err);
    setStatus(v, err?.message ? `Die Noten konnten nicht angezeigt werden: ${err.message}` : "Die Noten konnten nicht angezeigt werden.");
    $(".viewer-fallback", root).classList.remove("hidden");
  }
}

export function closeViewer(fromHistory = false) {
  const v = current;
  if (!v) return;
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
  const label = v.files[fileIdx].label;
  const newPages = Array.from({ length: doc.numPages }, (_, i) => ({ fileIdx, doc, num: i + 1, label }));
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
      <button class="viewer-btn viewer-fit" type="button" aria-label="Seitenbreite / ganze Seite">⤢</button>
      <button class="viewer-btn viewer-close" type="button" aria-label="Schließen">✕</button>
    </div>
    <div class="viewer-stage">
      <canvas class="viewer-canvas"></canvas>
      <p class="viewer-status"></p>
      <button class="btn secondary viewer-fallback hidden" type="button">Im Browser öffnen</button>
    </div>
    <button class="viewer-nav prev" type="button" aria-label="Vorherige Seite"><span>‹</span></button>
    <button class="viewer-nav next" type="button" aria-label="Nächste Seite"><span>›</span></button>`;
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
  $(".viewer-page", v.root).textContent = p ? `${p.label} · ${v.index + 1} / ${total}${loading}` : "";
  $(".viewer-nav.prev", v.root).disabled = v.index <= 0;
  $(".viewer-nav.next", v.root).disabled = v.index >= total - 1 && !loading;
}

async function render(v) {
  const p = v.pages[v.index];
  if (!p) return;
  updateBar(v);
  setStatus(v, "");
  const stage = $(".viewer-stage", v.root);
  const canvas = $(".viewer-canvas", v.root);
  const page = await p.doc.getPage(p.num);
  if (current !== v || v.pages[v.index] !== p) return;

  const base = page.getViewport({ scale: 1 });
  const availW = stage.clientWidth;
  const availH = stage.clientHeight;
  const scale = v.fitWidth ? availW / base.width : Math.min(availW / base.width, availH / base.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const viewport = page.getViewport({ scale: scale * dpr });

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
  if (current !== v || v.pages[v.index] !== p) return;
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
  canvas.getContext("2d").drawImage(off, 0, 0);
  stage.classList.toggle("fit-width", v.fitWidth);
  stage.scrollTop = 0;

  // nächste Seite schon vorbereiten
  const next = v.pages[v.index + 1];
  if (next) next.doc.getPage(next.num).catch(() => {});
}

function go(v, delta) {
  const target = v.index + delta;
  if (target < 0 || target >= v.pages.length) return;
  v.index = target;
  render(v);
}

function bindControls(v) {
  const root = v.root;
  $(".viewer-close", root).addEventListener("click", () => closeViewer());
  $(".viewer-nav.prev", root).addEventListener("click", () => go(v, -1));
  $(".viewer-nav.next", root).addEventListener("click", () => go(v, 1));
  $(".viewer-fit", root).addEventListener("click", () => { v.fitWidth = !v.fitWidth; render(v); });
  $(".viewer-fallback", root).addEventListener("click", () => {
    const blob = v.blobs.values().next().value;
    if (!blob) return;
    const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  });

  v.onKey = (e) => {
    if (["ArrowRight", "PageDown", " ", "ArrowDown"].includes(e.key) && !(v.fitWidth && e.key === "ArrowDown")) { e.preventDefault(); go(v, 1); }
    else if (["ArrowLeft", "PageUp", "ArrowUp"].includes(e.key) && !(v.fitWidth && e.key === "ArrowUp")) { e.preventDefault(); go(v, -1); }
    else if (e.key === "Escape") closeViewer();
  };
  window.addEventListener("keydown", v.onKey);

  let resizeTimer;
  v.onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => render(v), 150); };
  window.addEventListener("resize", v.onResize);

  // Zurück-Taste (Android) schließt den Betrachter
  v.onPop = () => closeViewer(true);
  window.addEventListener("popstate", v.onPop);

  // Wischen und Doppeltipp
  const stage = $(".viewer-stage", root);
  let startX = 0, startY = 0, startT = 0, lastTap = 0;
  stage.addEventListener("pointerdown", (e) => { startX = e.clientX; startY = e.clientY; startT = Date.now(); });
  stage.addEventListener("pointerup", (e) => {
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - startT < 800) {
      go(v, dx < 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const now = Date.now();
      if (now - lastTap < 300) { v.fitWidth = !v.fitWidth; render(v); lastTap = 0; }
      else lastTap = now;
    }
  });
}
