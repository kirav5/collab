// "Why it fits you": up to two reasons a listing suits the owner, drawn from their private notes — worked out here, on
// this device, with no model and no network. The notes never leave the browser: this module only reads the arguments
// it is given (it calls no API and stores nothing), and the reasons are never put into a chat card's data, which syncs
// to the account — the matches card works them out each time it is drawn.
//
// A reason is a fragment quoted from the listing — its title, its text, or one of its attributes ("pets allowed") —
// that shares a word with a fragment quoted from one note ("two pets"). There is no product knowledge here: no
// categories, no "dog → pets" table; two words match only when they are the same word, give or take a plural. Words
// the request itself already says are left out (every match shares those). A clause that says no / not / never /
// without, on either side, is skipped — word overlap can't tell whether that fits, so it says nothing — and so is a
// pair where both sides name numbers and none agree ("3 bedrooms" in a note, "bedrooms 2" on the listing).

// Grammar, not product knowledge: words that link any two sentences, so sharing one says nothing about a fit.
const COMMON = new Set(("the and but for with from into onto about over under have has had are was were been being does did done " +
  "will would can could should may might must our ours you your yours they them their she her his him its this that these those " +
  "there here what which who whom when where why how all any some each every very just also only than then too yes want need like " +
  "get got one per").split(" "));
const NEGATION = /\b(?:no|not|never|without|none|nor|cannot)\b|n['’]t\b/i;
const CLAUSE = /[.,;:!?\n•|·()[\]{}"“”]+|\s[-–—]\s/;

/** A word's plain form: lowercase, a plural folded to its singular ("ponies" → "pony", "boxes" → "box", "pets" → "pet"). */
export function stem(word) {
  const w = String(word).toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(?:ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The words that carry meaning, in plain form: letters in any script (with their vowel signs), three or more long. */
const words = text => (String(text ?? "").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
  .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !COMMON.has(w.toLowerCase())).map(stem).filter(w => !COMMON.has(w));
const clauses = text => String(text ?? "").split(CLAUSE).map(s => s.trim()).filter(Boolean);
const numbers = text => new Set(String(text).match(/\d+(?:\.\d+)?/g) ?? []);
/** Both sides name numbers and none agree: the overlap would be the wrong size, price or count. */
function numbersDisagree(a, b) {
  const x = numbers(a), y = numbers(b);
  return x.size > 0 && y.size > 0 && ![...x].some(n => y.has(n));
}
/** A clause cut to a few words around the first shared word, quoted as written (only the spacing tidied). */
function clip(clause, shared, n = 6) {
  const t = clause.split(/\s+/);
  if (t.length <= n) return t.join(" ");
  const i = Math.max(0, t.findIndex(w => words(w).some(s => shared.includes(s))));
  const from = Math.max(0, Math.min(i - 2, t.length - n));
  return t.slice(from, from + n).join(" ");
}

/** What a listing says, in quotable pieces: each attribute as "key value", then the clauses of its title and text. */
function pieces(listing) {
  const o = listing?.offer ?? listing ?? {};
  const attrs = Object.entries(o.attributes ?? {}).filter(([, v]) => v != null && String(v).trim())
    .map(([k, v]) => ({ text: `${k.replace(/[_-]+/g, " ")} ${String(v).trim()}`, attr: true }));
  const prose = [...new Set([o.title, o.details, listing?.text].filter(Boolean).map(String))];
  return [...attrs, ...prose.flatMap(t => clauses(t).map(text => ({ text, attr: false })))];
}

/**
 * Up to two { reason, note } for one listing — `reason` quoted from the listing, `note` from one of the owner's notes,
 * both containing the word they share; best first (more shared words, an attribute over prose, then the newer note),
 * one per note and no reason twice. `asked` is the request's own words, left out of the overlap. Pure: same input,
 * same output; it reads nothing else and changes nothing.
 */
export function fitsReasons(notes, listing, asked = "") {
  const skip = new Set(words(asked));
  const sides = pieces(listing).filter(p => !NEGATION.test(p.text)).map(p => ({ ...p, stems: new Set(words(p.text)) }));
  const found = [];
  for (const n of notes ?? []) {
    let best = null;
    for (const said of clauses(n?.text)) {
      if (NEGATION.test(said)) continue;
      const mine = [...new Set(words(said))].filter(w => !skip.has(w));
      for (const p of sides) {
        const shared = mine.filter(w => p.stems.has(w));
        if (!shared.length || numbersDisagree(said, p.text)) continue;
        const score = shared.length + (p.attr ? 0.5 : 0);
        if (!best || score > best.score) best = { score, reason: clip(p.text, shared), note: clip(said, shared), at: n.createdAt ?? 0 };
      }
    }
    if (best) found.push(best);
  }
  const seen = new Set();
  return found.sort((a, b) => b.score - a.score || b.at - a.at)
    .filter(r => !seen.has(r.reason.toLowerCase()) && seen.add(r.reason.toLowerCase()))
    .slice(0, 2).map(({ reason, note }) => ({ reason, note }));
}
