// My devices: one account on several devices (sign in with the same Google account on each). Every device registers
// itself with a public key; one that has Gemma can answer questions about the person's notes for their other devices
// — a phone asks the laptop — end-to-end encrypted through Firestore (e2e.js): only the person's own devices can read
// a question or an answer, never Google or the Collab server, and never the cloud model.
import { session } from "./api.js";
import { local } from "./local.js";
import { deviceKeys, open, openReply, publicJwk, seal, sealReply } from "./e2e.js";
import { MODEL, gemma } from "./gemma.js";

export const me = { id: null, name: null, serve: true, ready: false };
export const others = []; // the person's other devices, live
export const ONLINE_MS = 3 * 60_000, JOB_MS = 90_000;
const listeners = new Set();
export const onDevices = fn => listeners.add(fn);
const changed = () => { for (const fn of listeners) fn(); };

const rid = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
function deviceName() {
  const ua = navigator.userAgent;
  const what = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
    : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux PC" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "browser";
  return `${what} · ${browser}`;
}

// Testing two devices in one browser: ?devicetest=phone is a second device of the same account (its own identity,
// and no Gemma of its own), so one browser can check that another device answers for it.
export const testDevice = new URLSearchParams(location.search).get("devicetest")?.replace(/[^\w-]/g, "").slice(0, 16) || null;

/** This device's identity for this account (IndexedDB, per account): id, name, key pair, whether it serves others. */
async function identity() {
  const key = testDevice ? `device-${testDevice}` : "device";
  let rec = await local.get("meta", key);
  if (!rec?.keys) { rec = { id: key, deviceId: rid(), name: testDevice ? `Test ${testDevice}` : deviceName(), keys: await deviceKeys(), serve: true, createdAt: Date.now() }; await local.put("meta", rec); }
  return rec;
}

let fs = null, rec = null, beat = null, hosting = null;
const path = (...p) => ["users", session.uid, ...p].join("/");

/** Registers this device and keeps it current; watches the account's other devices. Needs a Google account. */
export async function startDevices() {
  if (fs || !session.uid || (session.user?.isAnonymous && !testDevice)) return;
  const f = await session.fsReady; if (!f?.raw) return;
  fs = f.raw; rec = await identity();
  me.id = rec.deviceId; me.name = rec.name; me.serve = rec.serve !== false;
  await heartbeat();
  beat = setInterval(() => { if (!document.hidden) heartbeat(); }, 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) heartbeat(); });
  const { collection, onSnapshot } = fs.mod;
  onSnapshot(collection(fs.db, path("devices")), s => {
    others.splice(0, others.length, ...s.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.id !== me.id)
      .map(d => ({ ...d, seen: d.lastSeen?.toMillis?.() ?? 0 })).sort((a, b) => b.seen - a.seen));
    changed();
  }, () => {});
  serve();
}

/** What this device tells the others: name, whether Gemma is ready here, whether it answers for them, its key. */
export async function heartbeat() {
  if (!fs || !rec) return;
  const { doc, setDoc, serverTimestamp } = fs.mod;
  me.ready = gemma.status === "downloaded" || gemma.status === "ready";
  await setDoc(doc(fs.db, path("devices", me.id)), { name: me.name, platform: navigator.platform || "", model: me.ready ? MODEL.id : null,
    gemma: me.ready, serve: me.serve, publicKey: await publicJwk(rec.keys), lastSeen: serverTimestamp() }, { merge: true }).catch(() => {});
}

export async function renameDevice(name) { rec.name = me.name = String(name).trim().slice(0, 60) || deviceName(); await local.put("meta", rec); await heartbeat(); changed(); }
export async function setServe(on) { rec.serve = me.serve = !!on; await local.put("meta", rec); await heartbeat(); serve(); changed(); }
/** Removes a device from the account: its record (and so its key) goes; it registers again next time it opens. */
export async function removeDevice(id) { const { doc, deleteDoc } = fs.mod; await deleteDoc(doc(fs.db, path("devices", id))); }

/** The other devices that can answer now: Gemma ready, answering for others, seen in the last few minutes. */
export const hosts = (now = Date.now()) => others.filter(d => d.gemma && d.serve && d.publicKey && now - d.seen < ONLINE_MS);

/**
 * Asks another of the person's devices. `answer(question, notes)` runs there; null if no device is available or none
 * answered in time (the caller decides what's allowed next — never the cloud unless the person allowed it).
 */
export async function askMyDevices(question, notes) {
  const host = hosts()[0];
  if (!fs || !host) return null;
  const { doc, setDoc, onSnapshot, updateDoc, serverTimestamp, Timestamp } = fs.mod;
  const jobId = rid(), { envelope, key } = await seal(host.publicKey, jobId, { question, notes: notes.map(n => ({ text: n.text })) });
  const ref = doc(fs.db, path("jobs", jobId));
  await setDoc(ref, { from: me.id, to: host.id, status: "open", ...envelope, createdAt: serverTimestamp(), expireAt: Timestamp.fromMillis(Date.now() + 10 * 60_000) });
  return new Promise(resolve => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); updateDoc(ref, { status: "expired" }).catch(() => {}); resolve({ timeout: true, host: host.name }); }, JOB_MS);
    stop = onSnapshot(ref, async s => {
      const j = s.data();
      if (!j || j.status === "open" || j.status === "working") return;
      clearTimeout(timer); stop();
      if (j.status !== "done" || !j.answer) return resolve({ failed: j.error ?? j.status, host: host.name });
      try { resolve({ ...(await openReply(key, jobId, j.answer)), host: host.name }); } catch { resolve({ failed: "unreadable", host: host.name }); }
    }, () => { clearTimeout(timer); resolve(null); });
  });
}

let answerer = null;
/** What this device runs for questions from the person's other devices (set by agent.js: Gemma over the notes sent). */
export const setAnswerer = fn => { answerer = fn; };

/** While this device has Gemma and answers for others: takes open questions addressed to it, one at a time. */
function serve() {
  hosting?.(); hosting = null;
  if (!fs || !me.serve || !answerer) return;
  const { collection, query, where, onSnapshot, doc, runTransaction, updateDoc, serverTimestamp } = fs.mod;
  hosting = onSnapshot(query(collection(fs.db, path("jobs")), where("to", "==", me.id), where("status", "==", "open")), s => {
    for (const d of s.docs) take(d.id, d.data());
  }, () => {});
  async function take(jobId, job) {
    if ((job.expireAt?.toMillis?.() ?? 0) < Date.now()) return;
    const ref = doc(fs.db, path("jobs", jobId));
    const claimed = await runTransaction(fs.db, async t => {
      const cur = await t.get(ref);
      if (!cur.exists() || cur.data().status !== "open") return false;
      t.update(ref, { status: "working", claimedAt: serverTimestamp() }); return true;
    }).catch(() => false);
    if (!claimed) return;
    try {
      const { payload, key } = await open(rec.keys.privateKey, jobId, job);
      const result = await answerer(payload.question, payload.notes ?? []);
      await updateDoc(ref, { status: "done", answer: await sealReply(key, jobId, result ?? { text: null }), doneAt: serverTimestamp() });
    } catch (e) {
      await updateDoc(ref, { status: "error", error: String(e?.message ?? e).slice(0, 80), doneAt: serverTimestamp() }).catch(() => {});
    }
  }
}
export const refreshServing = () => { heartbeat(); serve(); };
