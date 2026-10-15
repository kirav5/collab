// Where a question about the owner's private notes is answered. Pure, so it can be tested outside a browser.
//   mode:   "device-only" — Gemma on this device, nothing else
//           "my-devices"  — Gemma here, or on another of the person's own devices; never the cloud (the default)
//           "cloud"       — also Gemini in the cloud when no Gemma of theirs can answer (only if they choose it)
//   here:   Gemma is downloaded on this device · remote: another of their devices with Gemma is online
// → "here" · "remote" · "cloud" · "limitation" (nothing allowed can answer: the owner is told, nothing is sent)
export const MODES = ["device-only", "my-devices", "cloud"];

/** Saved choices from before Gemma ("device-first" let the cloud answer) become "my-devices": Gemma only. */
export const normalizeMode = m => (MODES.includes(m) ? m : "my-devices");

export function decideProcessing(mode, { here = false, remote = false } = {}) {
  if (here) return "here";
  if (mode !== "device-only" && remote) return "remote";
  if (mode === "cloud") return "cloud";
  return "limitation";
}

/** What the owner is told when nothing they allowed can answer — and nothing was sent anywhere. */
export function limitation(mode, { canRunHere = true, offline = false } = {}) {
  if (offline) return canRunHere
    ? "You're offline. Download Gemma in Settings › AI engine while you're online, and questions about your notes work offline too."
    : "You're offline, and this device can't run Gemma. Questions about your notes will work when you're back online and one of your devices with Gemma is open.";
  if (mode === "device-only") return canRunHere
    ? "Your notes are set to be answered on this device only, and Gemma isn't downloaded here. Download it in Settings › AI engine."
    : "Your notes are set to be answered on this device only, and this device can't run Gemma. Allow your other devices in Settings › AI engine.";
  return canRunHere
    ? "Your notes are answered only by Gemma on your own devices. Download Gemma in Settings › AI engine, or open Collab on one of your devices that has it. Nothing was sent anywhere."
    : "This device can't run Gemma. Open Collab on your laptop or desktop with Gemma downloaded, signed in with the same Google account, and it answers for this one. Nothing was sent anywhere.";
}

const norm = s => s.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
const nums = s => (s.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []);

/** Accepts a model's answer only if every piece of evidence is quoted from the notes and it invents no numbers. */
export function checkedAnswer(raw, notes) {
  const m = String(raw ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o; try { o = JSON.parse(m[0]); } catch { return null; }
  const corpus = norm(notes.map(n => n.text).join("\n"));
  if (o.answer && (o.evidence ?? []).length && o.evidence.every(e => corpus.includes(norm(String(e)))) && nums(String(o.answer)).every(n => corpus.includes(n)))
    return { text: String(o.answer), evidence: o.evidence.map(String) };
  return null;
}

/** Kept for older callers: the device-only message. */
export const LIMITATION = limitation("device-only");
