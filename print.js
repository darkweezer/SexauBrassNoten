// NotenApp – Druckansicht „Inhaltsverzeichnis“
//
// Erstellt ein helles, druckerfreundliches Verzeichnis (Nr. und Stück) auf A4.
// Einstellbar: nur aktive oder alle Stücke, Hoch- oder Querformat, Anzahl Seiten.
// Die Einträge werden gleichmäßig auf Seiten und Spalten verteilt; die Schriftgröße passt sich an.

const PAGE = { hoch: { w: 210, h: 297 }, quer: { w: 297, h: 210 } }; // A4 in mm
const MARGIN = 12;        // Seitenrand in mm
const HEADER = 16;        // Kopfzeile in mm
const FOOTER = 7;         // Fußzeile in mm
const MAX_LINE = 7.5;     // größter Zeilenabstand in mm (gut lesbar am Notenständer)
const MIN_LINE = 3.6;     // kleinster Zeilenabstand in mm
const COL_GAP = 8;        // Abstand zwischen Spalten in mm
const MIN_COL_WIDTH = 55; // Spalten nicht schmaler als das (mm)

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let ctx = null;

/** @param {{ getSongs: () => any[], isActive: (song) => boolean }} options */
export function initPrint(options) {
  ctx = options;
  const form = $("#print-form");
  form.addEventListener("input", renderPrint);
  form.addEventListener("change", renderPrint);
  $("#print-btn").addEventListener("click", () => {
    renderPrint();
    window.print();
  });
  window.addEventListener("resize", fitPreview);
}

function settings() {
  const f = $("#print-form");
  return {
    scope: f.elements.scope.value,                 // "aktiv" | "alle"
    orientation: f.elements.orientation.value,     // "hoch" | "quer"
    pages: Math.max(1, Math.min(20, Number(f.elements.pages.value) || 1)),
    sort: f.elements.sort.value,                   // "nr" | "titel"
    cols: Number(f.elements.cols.value) || 0,       // 0 = automatisch
    title: f.elements.title.value.trim() || "Sexau Brass · Notenverzeichnis",
    markInactive: f.elements.markInactive.checked,
  };
}

function compareSongs(sort) {
  return (a, b) => sort === "titel"
    ? a.title.localeCompare(b.title, "de")
    : (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title, "de");
}

/**
 * Bestimmt Spalten und Zeilenhöhe so, dass alle Einträge auf die gewünschte Seitenzahl passen.
 * Mehr Spalten nur, wenn die Schrift sonst zu klein würde.
 */
function computeLayout(count, opt) {
  const page = PAGE[opt.orientation];
  const innerW = page.w - 2 * MARGIN;
  const innerH = page.h - 2 * MARGIN - HEADER - FOOTER;
  const maxCols = Math.max(1, Math.floor((innerW + COL_GAP) / (MIN_COL_WIDTH + COL_GAP)));
  const lineFor = (cols) => Math.min(MAX_LINE, innerH / Math.max(1, Math.ceil(count / (opt.pages * cols))));

  let cols;
  if (opt.cols) {
    cols = Math.min(opt.cols, maxCols);
  } else {
    // Standard: hochkant 2, quer 3 Spalten; mehr nur, wenn die Schrift sonst zu klein würde
    cols = Math.min(maxCols, opt.orientation === "quer" ? 3 : 2);
    while (cols < maxCols && lineFor(cols) < 5) cols++;
  }
  const line = Math.max(MIN_LINE, lineFor(cols));
  const rows = Math.min(Math.ceil(count / (opt.pages * cols)), Math.floor(innerH / line));
  const pageCount = Math.max(1, Math.ceil(count / (cols * rows)));
  return { cols, rows, line, page, innerW, innerH, pageCount, overflow: pageCount > opt.pages };
}

export function renderPrint() {
  if (!ctx) return;
  const opt = settings();
  const all = ctx.getSongs();
  const songs = all
    .filter((s) => opt.scope === "alle" || ctx.isActive(s))
    .sort(compareSongs(opt.sort));
  const inactiveCount = all.filter((s) => !ctx.isActive(s)).length;
  $("#print-scope-alle-label").textContent = inactiveCount ? `Alle Stücke (auch ${inactiveCount} nicht aktive)` : "Alle Stücke";
  $("#print-mark-row").classList.toggle("hidden", opt.scope !== "alle");

  // @page-Regel für den Druck: Format und Ausrichtung
  let style = $("#print-page-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "print-page-style";
    document.head.append(style);
  }
  style.textContent = `@page { size: A4 ${opt.orientation === "quer" ? "landscape" : "portrait"}; margin: 0; }`;

  const root = $("#print-pages");
  if (!songs.length) {
    root.innerHTML = "";
    $("#print-info").textContent = all.length ? "Keine Stücke für diese Auswahl." : "Noch keine Noten geladen. Bitte zuerst anmelden.";
    $("#print-btn").disabled = true;
    return;
  }
  $("#print-btn").disabled = false;

  const L = computeLayout(songs.length, opt);
  const perPage = L.cols * L.rows;
  const font = Math.min(4.6, L.line * 0.62); // mm
  const date = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

  const pages = [];
  for (let p = 0; p < L.pageCount; p++) {
    const chunk = songs.slice(p * perPage, (p + 1) * perPage);
    const cols = [];
    for (let c = 0; c < L.cols; c++) {
      const items = chunk.slice(c * L.rows, (c + 1) * L.rows);
      cols.push(`<ol class="pp-col">${items.map((s) => {
        const inactive = !ctx.isActive(s);
        const mark = inactive && opt.markInactive ? " pp-inactive" : "";
        return `<li class="pp-row${mark}"><span class="pp-num">${esc(s.number ?? "")}</span><span class="pp-title">${esc(s.title)}</span></li>`;
      }).join("")}</ol>`);
    }
    pages.push(`
      <section class="print-page" style="width:${L.page.w}mm;height:${L.page.h}mm;padding:${MARGIN}mm">
        <header class="pp-head" style="height:${HEADER}mm">
          <h2>${esc(opt.title)}</h2>
          <span>Stand ${date} · ${songs.length} Stücke</span>
        </header>
        <div class="pp-cols" style="height:${L.innerH}mm;grid-template-columns:repeat(${L.cols},1fr);column-gap:${COL_GAP}mm;font-size:${font}mm;--line:${L.line}mm">
          ${cols.join("")}
        </div>
        <footer class="pp-foot" style="height:${FOOTER}mm">
          ${opt.scope === "alle" && opt.markInactive && inactiveCount ? `<span><span class="pp-inactive-sample">grau</span> = derzeit nicht aktiv</span>` : "<span></span>"}
          <span>Seite ${p + 1} / ${L.pageCount}</span>
        </footer>
      </section>`);
  }
  root.innerHTML = pages.join("");

  $("#print-info").textContent = L.overflow
    ? `Passt nicht auf ${opt.pages} ${opt.pages === 1 ? "Seite" : "Seiten"}, es werden ${L.pageCount} Seiten (kleinste lesbare Schrift).`
    : `${songs.length} Stücke auf ${L.pageCount} ${L.pageCount === 1 ? "Seite" : "Seiten"}, ${L.cols} ${L.cols === 1 ? "Spalte" : "Spalten"} je Seite.`;
  fitPreview();
}

// Vorschau auf Bildschirmbreite verkleinern (beim Drucken wird in echter Größe gedruckt)
function fitPreview() {
  const wrap = $("#print-preview");
  const root = $("#print-pages");
  const first = root?.firstElementChild;
  if (!wrap || !first || !wrap.clientWidth) return;
  root.style.transform = "";
  const scale = Math.min(1, (wrap.clientWidth - 4) / first.offsetWidth);
  root.style.transform = `scale(${scale})`;
  root.style.width = `${first.offsetWidth}px`;
  wrap.style.height = `${root.offsetHeight * scale}px`;
}
