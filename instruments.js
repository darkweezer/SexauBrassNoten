// NotenApp – Instrumente aus Dateinamen erkennen und zusammenfassen
//
// In den Drives heißen dieselben Instrumente sehr unterschiedlich, z. B.
// "Trp", "Trompete" und "Trumpet". Diese Liste fasst sie unter einem Namen zusammen.
// Neue Schreibweise gefunden? Einfach unten beim passenden Instrument ergänzen
// (klein geschrieben, ohne Umlaute: ö -> oe, ü -> ue, ä -> ae, ß -> ss).

export const INSTRUMENTE = [
  ["Piccolo",               ["picc", "piccolo"]],
  ["Flöte",                 ["floete", "flote", "flute", "fl"]],
  ["Oboe",                  ["oboe", "coranglais", "coranglaise", "englischhorn"]],
  ["Fagott",                ["fagott", "basson", "bassoon"]],
  ["Klarinette",            ["klar", "klarinette", "karinette", "kla", "clar", "clarinet", "clarinette", "esklar", "soloklar"]],
  ["Altklarinette",         ["altklar", "altklarinette"]],
  ["Bassklarinette",        ["bassklar", "basklar", "bassklarinette", "bassclarinet", "contraklar"]],
  ["Sopransaxophon",        ["soprsax", "sopransax", "sopransaxophon", "sopranosax"]],
  ["Altsaxophon",           ["altsax", "altax", "altsaxophon", "altosax", "alto"]],
  ["Tenorsaxophon",         ["tensax", "tenorsax", "tenorsaxophon", "tenor"]],
  ["Baritonsaxophon",       ["barsax", "barisax", "baritonsax", "baritonsa", "baritonsaxophon", "baritonesax", "baritone"]],
  ["Trompete",              ["trp", "trompete", "trumpet", "piston", "solotrompete", "cornet", "basstrompete"]],
  ["Flügelhorn",            ["flgh", "fluegelhorn", "flugelhorn"]],
  ["Horn",                  ["horn", "hornf", "fhorn", "eshorn", "corni", "corn", "melodiehorn"]],
  ["Tenorhorn",             ["tenh", "ten", "tenhorn", "tenorhorn"]],
  ["Bariton / Euphonium",   ["bar", "bari", "bariton", "euph", "euphonium", "tenortuba", "tentuba", "tenbass"]],
  ["Posaune",               ["pos", "posaune", "trombone", "basspos", "bassposaune"]],
  ["Tuba / Bass",           ["bass", "bas", "tuba", "basses"]],
  ["E-Bass",                ["ebass", "electrbass", "electricbass", "bassgitarre", "stringbass", "contrabass"]],
  ["Gitarre",               ["gitarre", "guitar", "egitarre", "guitarist"]],
  ["Keyboard / Klavier",    ["keyb", "keyboard", "piano", "klavier", "synthesizer", "synthesyser", "synth"]],
  ["Akkordeon",             ["akkordeon"]],
  ["Schlagzeug",            ["drums", "drum", "drumset", "schlagzeug", "snare", "kleinetrommel", "grossetrommel", "grtrommel", "becken", "concertdrum"]],
  ["Percussion",            ["perc", "percussion", "auxpercussion", "aux", "tambourin", "tambourine", "tamburin"]],
  ["Mallets / Lyra",        ["mallets", "malletperc", "glockenspiel", "lyra", "xyl", "xylo", "xylophon", "xylophone", "vibes", "vibraphone", "bells", "marimba"]],
  ["Pauken",                ["pauke", "pauken", "timpani"]],
  ["Gesang / Text",         ["vocal", "vocals", "voval", "gesang", "liedtext", "text"]],
  ["Partitur",              ["partitur", "score", "sore", "direktion", "dirigent"]],
  ["Stimme (frei besetzbar)", ["stimme", "begleitung", "begelitung", "solo", "solostimme", "solostelle"]],
  ["Infos",                 ["instrumentenliste", "stimmenliste", "hinweise", "vorwort", "werkbeschreibung", "musikalisches"]],
];

export const SONSTIGE = "Sonstige";

// Reihenfolge im Auswahlfeld = Reihenfolge der Liste oben (Partitur-Ordnung)
export const INSTRUMENT_ORDER = [...INSTRUMENTE.map(([name]) => name), SONSTIGE];

export function normToken(token) {
  return String(token).toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    // Stimmnummer und Zusätze am Ende entfernen: "AltSax1" -> "altsax", "Horn1u3" -> "horn", "Bass2inB" -> "bass"
    .replace(/in(b|c|es|f)$/, "")
    .replace(/\d+(u\d*)*$/, "");
}

const LOOKUP = new Map();
for (const [name, keys] of INSTRUMENTE) for (const k of keys) LOOKUP.set(k, name);
// lange Schlüssel zuerst, damit "bassklar" vor "bass" greift
const KEYS_BY_LENGTH = [...LOOKUP.keys()].sort((a, b) => b.length - a.length);

// Wie lookupToken, liefert aber zusätzlich den getroffenen Schlüssel (z. B. "euph" -> Bariton / Euphonium)
export function describeToken(token, allowSuffix = true) {
  const t = normToken(token);
  if (!t) return null;
  if (LOOKUP.has(t)) return { name: LOOKUP.get(t), key: t };
  if (allowSuffix) {
    for (const k of KEYS_BY_LENGTH) {
      if (t.length >= k.length + 4 && t.endsWith(k)) return { name: LOOKUP.get(k), key: k };
    }
  }
  return null;
}

function lookupToken(token, allowSuffix = true) {
  const t = normToken(token);
  if (!t) return null;
  if (LOOKUP.has(t)) return LOOKUP.get(t);
  // zusammengeklebte Namen wie "SlavnostniAltSax" oder "PolkaFlöte": Ende vergleichen
  if (allowSuffix) {
    for (const k of KEYS_BY_LENGTH) {
      if (t.length >= k.length + 4 && t.endsWith(k)) return LOOKUP.get(k);
    }
  }
  return null;
}

const FREI = "Stimme (frei besetzbar)";

/**
 * Sucht in einer Liste von Wortteilen alle bekannten Instrumente.
 * Zwei aufeinanderfolgende Teile werden zuerst gemeinsam geprüft ("E" + "Bass" -> E-Bass).
 * Eine Stimme für mehrere Instrumente ("Oboe_Glockenspiel") erscheint bei beiden.
 * Ergebnis: { instruments: [...], index } (index = Position des ersten Treffers) oder null.
 */
export function findInstruments(tokens) {
  const found = [];
  let first = -1;
  for (let i = 0; i < tokens.length; i++) {
    const start = i;
    let hit = null;
    if (i + 1 < tokens.length) {
      hit = lookupToken(tokens[i] + tokens[i + 1], false);
      if (hit) i++;
    }
    if (!hit) hit = lookupToken(tokens[i]);
    if (hit) {
      if (first < 0) first = start;
      if (!found.includes(hit)) found.push(hit);
    }
  }
  if (!found.length) return null;
  // "Solo_Klar" ist eine Klarinettenstimme, keine frei besetzbare Stimme
  const instruments = found.length > 1 ? found.filter((x) => x !== FREI) : found;
  return { instruments, index: first };
}

/** Sammelordner wie „Keyboard“: der Ordnername besteht nur aus Instrumentnamen (exakt, ohne Wortende-Suche). */
export function isCollectionTitle(title) {
  const tokens = String(title ?? "").split(/[_\s-]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => LOOKUP.has(normToken(t)));
}
