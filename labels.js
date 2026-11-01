// NotenApp – Stimmen voll ausgeschrieben anzeigen
//
// Aus Kurzformen wie "Trp 1 B", "AltSax 2" oder "Part 3 C Euph" wird
//   Instrument  Stimme  [in Stimmung]  [· Part N]
// z. B. "Trompete 1", "Altsaxophon 2", "Euphonium in C · Part 3".
// Die Stimmung (B, Es, F, C …) steht nur dabei, wenn es dieselbe Stimme im Stück in mehreren Stimmungen gibt.

import { describeToken, SONSTIGE } from "./instruments.js";

// Für zusammengefasste Instrumente den genaueren Namen zeigen, den die Datei benutzt
const SPECIFIC = {
  bar: "Bariton", bari: "Bariton", bariton: "Bariton",
  euph: "Euphonium", euphonium: "Euphonium", tenortuba: "Tenortuba", tentuba: "Tenortuba", tenbass: "Tenorbass",
  tuba: "Tuba", bass: "Bass", bas: "Bass", basses: "Bass",
  keyb: "Keyboard", keyboard: "Keyboard", piano: "Klavier", klavier: "Klavier",
  synth: "Synthesizer", synthesizer: "Synthesizer", synthesyser: "Synthesizer",
  glockenspiel: "Glockenspiel", lyra: "Lyra", xyl: "Xylophon", xylo: "Xylophon", xylophon: "Xylophon", xylophone: "Xylophon",
  vibes: "Vibraphon", vibraphone: "Vibraphon", marimba: "Marimba", bells: "Glockenspiel", mallets: "Mallets", malletperc: "Mallets",
  vocal: "Gesang", vocals: "Gesang", voval: "Gesang", gesang: "Gesang", liedtext: "Liedtext", text: "Text",
  coranglais: "Englischhorn", coranglaise: "Englischhorn", englischhorn: "Englischhorn",
  esklar: "Es-Klarinette", cornet: "Kornett", melodiehorn: "Melodiehorn", soloklar: "Klarinette", solotrompete: "Trompete", basstrompete: "Basstrompete",
  basspos: "Bassposaune", bassposaune: "Bassposaune", contraklar: "Kontrabassklarinette",
  stimme: "Stimme", begleitung: "Begleitung", begelitung: "Begleitung", solo: "Stimme", solostimme: "Stimme", solostelle: "Stimme",
  snare: "Snare", kleinetrommel: "Kleine Trommel", grossetrommel: "Große Trommel", grtrommel: "Große Trommel", becken: "Becken",
  instrumentenliste: "Instrumentenliste", stimmenliste: "Stimmenliste", hinweise: "Hinweise", vorwort: "Vorwort",
  werkbeschreibung: "Werkbeschreibung",
};
const NICE = { "Stimme (frei besetzbar)": "Stimme", "Tuba / Bass": "Bass", "Bariton / Euphonium": "Bariton",
  "Keyboard / Klavier": "Keyboard", "Mallets / Lyra": "Mallets", "Gesang / Text": "Gesang" };

const PITCHES = { b: "B", c: "C", es: "Es", f: "F", as: "As", des: "Des", ges: "Ges", d: "D", g: "G", a: "A", eb: "Es", bb: "B" };
// "B", "inB", "Es" … sowie zusammengeschrieben "BC", "EsC" (Stimme für beide Stimmungen)
const pitchOf = (t) => {
  const m = /^(?:in)?((?:b|c|es|f|as)+|des|ges|d|g|a|eb|bb)$/i.exec(t);
  if (!m) return null;
  const parts = m[1].toLowerCase().match(/des|ges|es|as|eb|bb|b|c|f|d|g|a/g) ?? [];
  return parts.map((x) => PITCHES[x]).join("/");
};
const NOISE = /^(seite|page|st|nr|no|und|u|and|in|neu|new|version|v)$/i;
const EXTRA_NAMES = { arr: "arrangiert", arrangiert: "arrangiert", alt: "alternativ", alternativ: "alternativ" };

/** Zerlegt eine Stimmenbezeichnung (ohne Seitenangabe) in ihre Teile. */
export function parseVoice(base) {
  const raw = String(base).replace(/\(S\.\d+\)/g, " ").replace(/([a-zäöü])(\d)/gi, "$1 $2").replace(/(\d)(in|arr)/gi, "$1 $2").trim();
  let tokens = raw.split(/[\s_\-\/,+]+/).filter(Boolean);
  const out = { names: [], nums: [], pitch: null, part: null, solo: false, extras: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const low = t.toLowerCase();
    // Part / Super Part / Solopart
    if (/^(super)?part$/i.test(t) || /^solopart$/i.test(t)) {
      if (/^solopart$/i.test(t)) out.solo = true;
      const nxt = tokens[i + 1];
      const label = /^super/i.test(t) ? "Super Part" : "Part";
      if (nxt && /^\d+[a-z]?$/i.test(nxt)) { out.part = `${label} ${nxt}`; i++; }
      else if (/^super/i.test(t)) out.part = "Super Part";
      else if (low === "part" && tokens[i - 1]?.toLowerCase() === "super") out.part = "Super Part";
      continue;
    }
    if (low === "super" && /^part/i.test(tokens[i + 1] ?? "")) continue;
    if (/^solo/i.test(t) && !describeToken(t.replace(/^solo/i, ""), false)) { out.solo = true; if (low === "solo") continue; }
    // Stimmnummern: "1", "3u4", "1u3"
    const nm = /^(\d)(?:u(\d)?)?$/i.exec(t);
    if (nm) { out.nums.push(nm[1]); if (nm[2]) out.nums.push(nm[2]); continue; }
    if (/^u$/i.test(t)) continue;
    if (/^\d{2}$/.test(t)) { out.nums.push(String(Number(t))); continue; }
    const p = pitchOf(t);
    if (p && (out.names.length || i > 0 || tokens.length > 1)) {
      out.pitch = out.pitch && !out.pitch.split("/").includes(p) ? `${out.pitch}/${p}` : (out.pitch ?? p);
      continue;
    }
    // Instrument (auch zwei Teile zusammen: "E" + "Bass")
    const nxt = tokens[i + 1];
    const pair = nxt && /^[a-zäöüß]+$/i.test(nxt) && !pitchOf(nxt) ? describeToken(t + nxt, false) : null;
    const hit = pair ?? describeToken(t);
    if (hit) {
      if (pair) i++;
      const key = pair ? (t + tokens[i]).toLowerCase() : hit.key;
      if (/^solo/i.test(t)) out.solo = true;
      const name = SPECIFIC[key] ?? SPECIFIC[hit.key] ?? NICE[hit.name] ?? hit.name;
      if (!out.names.includes(name)) out.names.push(name);
      continue;
    }
    if (NOISE.test(t) || /^\d{3,}$/.test(t)) continue;
    out.extras.push(EXTRA_NAMES[low] ?? t);
  }
  // "Stimme" neben einem echten Instrument weglassen
  if (out.names.length > 1) out.names = out.names.filter((n) => n !== "Stimme" && n !== "Begleitung");
  return out;
}

function compose(p, withPitch) {
  let s = (p.solo ? "Solo " : "") + p.names.join(" / ");
  if (p.nums.length) s += ` ${[...new Set(p.nums)].join("/")}`;
  if (withPitch && p.pitch) s += ` in ${p.pitch}`;
  if (p.part) s += ` · ${p.part}`;
  if (p.extras.length) s += ` (${p.extras.join(" ")})`;
  return s.trim();
}

/**
 * Liefert für alle Stimmen eines Stücks die ausgeschriebene Bezeichnung.
 * @param {string[]} bases  Stimmenbezeichnungen ohne Seitenangabe (eine pro Stimme)
 * @returns {Map<string,string>} base -> Anzeigename
 */
export function fullLabels(bases, { keepOriginal = false } = {}) {
  if (keepOriginal) return new Map(bases.map((b) => [b, b]));
  const parsed = bases.map((b) => [b, parseVoice(b)]);
  // Stimmung nur zeigen, wenn dieselbe Stimme in mehreren Stimmungen vorkommt
  const pitchesFor = new Map();
  for (const [, p] of parsed) {
    if (!p.names.length) continue;
    const k = compose(p, false);
    if (!pitchesFor.has(k)) pitchesFor.set(k, new Set());
    pitchesFor.get(k).add(p.pitch ?? "-");
  }
  const result = new Map();
  for (const [b, p] of parsed) {
    if (!p.names.length) { result.set(b, b); continue; } // nichts erkannt (z. B. Scans): Original zeigen
    const multi = (pitchesFor.get(compose(p, false))?.size ?? 0) > 1;
    result.set(b, compose(p, multi));
  }
  // gleiche Anzeigenamen für verschiedene Dateien: Original in Klammern dazu
  const count = new Map();
  for (const v of result.values()) count.set(v, (count.get(v) ?? 0) + 1);
  for (const [b, v] of result) if (count.get(v) > 1 && v !== b) result.set(b, `${v} (${b})`);
  return result;
}

export { SONSTIGE };
