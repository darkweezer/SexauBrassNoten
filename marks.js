// NotenApp – persönliche Markierungen in den Noten
//
// Jede Person kann auf den Notenseiten markieren (roter Kreis, Textmarker, Stift, Text).
// Die Original-PDFs werden NICHT verändert: Die Markierungen liegen als eigene Ebene über der Seite.
//
// Gespeichert wird zweifach:
//  1. sofort im Gerät (localStorage) – funktioniert auch offline,
//  2. zusätzlich als Datei „NotenApp-Markierungen.json“ im eigenen Google Drive der Person.
//     So sind die Markierungen auf Handy, Tablet und PC gleich und gesichert.
//     Dafür stimmt man einmal zu, dass die App eigene Dateien anlegen darf (drive.file).
//
// Aufbau der Daten:
//  { pages: { "<Datei-ID>:<Seite>": { t: <Zeitpunkt der letzten Änderung>, items: [ … ] } } }
//  Positionen sind Anteile der Seite (0 … 1), damit sie bei jedem Zoom und Bildschirm passen.
//  items: { k: "c", c: Farbe, x, y, w, h }      Kreis (umgebendes Rechteck)
//         { k: "m", c: Farbe, p: [x, y, x, y …] } Textmarker (halbtransparent)
//         { k: "p", c: Farbe, p: [x, y, x, y …] } Stift
//         { k: "t", c: Farbe, x, y, s: "Text" }   Text (x, y = linke obere Ecke)
// Abgleich: je Seite gilt die zuletzt geänderte Fassung.

import { signIn, canWrite, loadMarksFile, saveMarksFile } from "./drive.js";

const LS_SYNC = "notenapp.markierungen.abgleich"; // "ja" = Drive-Abgleich erlaubt, "nein" = nur im Gerät

export const MARK_COLORS = [
  { id: "rot", value: "#e3241b", label: "Rot" },
  { id: "blau", value: "#1f5fd6", label: "Blau" },
  { id: "gruen", value: "#1e9b3c", label: "Grün" },
  { id: "schwarz", value: "#151515", label: "Schwarz" },
  { id: "gelb", value: "#ffd400", label: "Gelb" },
];

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }

function mergePages(local, remote) {
  const out = { ...local };
  let localChanged = false;
  let needUpload = false;
  for (const [key, page] of Object.entries(remote ?? {})) {
    if (!page || !Array.isArray(page.items)) continue;
    if (!out[key] || (page.t ?? 0) > (out[key].t ?? 0)) { out[key] = page; localChanged = true; }
  }
  for (const [key, page] of Object.entries(out)) {
    const r = remote?.[key];
    if (!r || (page.t ?? 0) > (r.t ?? 0)) needUpload = true;
  }
  return { pages: out, localChanged, needUpload };
}

/**
 * Speicher für die Markierungen einer Person.
 * @param {string} userKey  Google-Adresse (oder "gast")
 */
export function createMarks(userKey) {
  const lsKey = `notenapp.markierungen.${userKey}`;
  let data;
  try { data = JSON.parse(lsGet(lsKey) ?? "{}") ?? {}; } catch { data = {}; }
  if (!data.pages || typeof data.pages !== "object") data.pages = {};

  let status = "aus";     // aus | bereit | laeuft | offline | fehler
  let running = null;
  let again = false;
  let timer = null;
  const listeners = new Set();
  const emit = (what) => { for (const fn of listeners) { try { fn(what); } catch (e) { console.error(e); } } };
  const setStatus = (s) => { if (s !== status) { status = s; emit("status"); } };

  const persist = () => {
    if (!lsSet(lsKey, JSON.stringify(data))) console.warn("Markierungen konnten im Gerät nicht gespeichert werden.");
  };

  async function runSync() {
    if (lsGet(LS_SYNC) !== "ja") { setStatus("aus"); return; }
    if (!navigator.onLine) { setStatus("offline"); return; }
    if (!canWrite()) {
      // still neu anmelden; Google liefert die schon erteilte Schreib-Erlaubnis mit
      try { await signIn({ interactive: false }); } catch {}
      if (!canWrite()) { setStatus("aus"); return; }
    }
    setStatus("laeuft");
    try {
      const remote = await loadMarksFile();
      const m = mergePages(data.pages, remote?.data?.pages);
      if (m.localChanged) {
        data.pages = m.pages;
        persist();
        emit("pages");
      }
      if (m.needUpload || !remote) {
        await saveMarksFile(remote?.fileId ?? null, { app: "NotenApp", version: 1, geaendert: new Date().toISOString(), pages: data.pages });
      }
      data.dirty = false;
      persist();
      setStatus("bereit");
    } catch (err) {
      console.warn("Markierungen: Abgleich mit Drive fehlgeschlagen", err);
      setStatus(navigator.onLine ? "fehler" : "offline");
    }
  }

  async function sync() {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await runSync(); } while (again);
    })().finally(() => { running = null; });
    return running;
  }

  window.addEventListener("online", () => { if (data.dirty || status !== "bereit") sync(); });
  if (lsGet(LS_SYNC) === "ja") status = navigator.onLine ? "bereit" : "offline";

  return {
    get(key) { return data.pages[key]?.items ?? []; },
    set(key, items) {
      const clean = items.filter(Boolean);
      if (clean.length || data.pages[key]) data.pages[key] = { t: Date.now(), items: clean };
      data.dirty = true;
      persist();
      clearTimeout(timer);
      if (lsGet(LS_SYNC) === "ja") timer = setTimeout(sync, 3000);
    },
    flush() { if (timer) { clearTimeout(timer); timer = null; sync(); } },
    sync,
    status: () => status,
    syncChoice: () => lsGet(LS_SYNC), // null = noch nie gefragt
    /** Drive-Abgleich einschalten. Muss direkt aus einem Klick heraus aufgerufen werden (Google-Fenster). */
    async enableSync() {
      try {
        if (!canWrite()) await signIn({ interactive: true, withWrite: true });
      } catch (err) {
        if (lsGet(LS_SYNC) !== "ja") lsSet(LS_SYNC, "nein");
        setStatus("aus");
        throw err;
      }
      if (!canWrite()) { lsSet(LS_SYNC, "nein"); setStatus("aus"); return false; }
      lsSet(LS_SYNC, "ja");
      await sync();
      return true;
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// ---------- Zeichnen ----------

const round = (n) => Math.round(n * 10000) / 10000;
export const roundPoint = (x, y) => [round(Math.min(1, Math.max(0, x))), round(Math.min(1, Math.max(0, y)))];

// Strichstärken und Schriftgröße als Anteil der Seitenbreite
const LINE = { c: 0.0045, p: 0.0032, m: 0.022 };
export const TEXT_SIZE = 0.03;

function strokePath(ctx, p, w, h) {
  ctx.beginPath();
  ctx.moveTo(p[0] * w, p[1] * h);
  if (p.length === 2) ctx.lineTo(p[0] * w + 0.01, p[1] * h); // einzelner Tipp = Punkt
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * w, p[i + 1] * h);
  ctx.stroke();
}

/** Zeichnet Markierungen auf eine Leinwand der Größe w × h (Pixel der ganzen Seite). */
export function drawMarks(ctx, items, w, h) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const it of items) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ctx.fillStyle = it.c;
    if (it.k === "c") {
      ctx.lineWidth = Math.max(1.5, LINE.c * w);
      ctx.beginPath();
      ctx.ellipse((it.x + it.w / 2) * w, (it.y + it.h / 2) * h, Math.max(1, (it.w / 2) * w), Math.max(1, (it.h / 2) * h), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (it.k === "m") {
      ctx.globalAlpha = 0.42;
      ctx.lineWidth = LINE.m * w;
      ctx.lineCap = "butt";
      strokePath(ctx, it.p, w, h);
      ctx.lineCap = "round";
    } else if (it.k === "p") {
      ctx.lineWidth = Math.max(1.2, LINE.p * w);
      strokePath(ctx, it.p, w, h);
    } else if (it.k === "t") {
      ctx.font = `600 ${TEXT_SIZE * w}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(it.s, it.x * w, it.y * h);
    }
  }
  ctx.restore();
}

// Abstand Punkt–Strecke (in Pixeln)
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Liegt der Punkt (x, y als Anteil der Seite) auf dieser Markierung? tol in Pixeln. */
export function hitMark(it, x, y, w, h, tol = 14) {
  const px = x * w, py = y * h;
  if (it.k === "c") {
    const rx = Math.max(1, (it.w / 2) * w), ry = Math.max(1, (it.h / 2) * h);
    const cx = (it.x + it.w / 2) * w, cy = (it.y + it.h / 2) * h;
    const r = Math.hypot((px - cx) / rx, (py - cy) / ry);
    return r <= 1 || (r - 1) * Math.min(rx, ry) < tol;
  }
  if (it.k === "m" || it.k === "p") {
    const half = it.k === "m" ? (LINE.m * w) / 2 : 0;
    const p = it.p;
    if (p.length === 2) return Math.hypot(px - p[0] * w, py - p[1] * h) < tol + half;
    for (let i = 2; i < p.length; i += 2) {
      if (segDist(px, py, p[i - 2] * w, p[i - 1] * h, p[i] * w, p[i + 1] * h) < tol + half) return true;
    }
    return false;
  }
  if (it.k === "t") {
    const size = TEXT_SIZE * w;
    const tw = it.s.length * size * 0.6;
    return px >= it.x * w - tol && px <= it.x * w + tw + tol && py >= it.y * h - tol && py <= it.y * h + size * 1.2 + tol;
  }
  return false;
}
