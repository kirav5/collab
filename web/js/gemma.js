// Gemma on this device: Google's Gemma 4 E2B (Apache-2.0) running inside the browser on the GPU (WebGPU) through
// MediaPipe's LLM Inference runtime. The model and the runtime are downloaded once into this browser's storage —
// resumably, in 64 MB pieces — so after that it answers with no connection at all, and nothing it reads leaves the
// device. No server, no Ollama: the browser is the runtime.
const RUNTIME = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.29";
const FILES = { bundle: `${RUNTIME}/genai_bundle.mjs`, loader: `${RUNTIME}/wasm/genai_wasm_internal.js`, wasm: `${RUNTIME}/wasm/genai_wasm_internal.wasm` };
export const MODEL = {
  id: "gemma-4-e2b", label: "Gemma 4 E2B",
  url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task",
  size: 2003697664, gpuMB: 1800,
};
const CACHE = "collab-gemma-v1", PIECE = 64 * 1024 * 1024, PIECES = Math.ceil(MODEL.size / PIECE);
const piece = i => new Request(`/gemma-store/${MODEL.id}/${i}`); // cache keys only — never fetched
const DONE = new Request(`/gemma-store/${MODEL.id}/complete`);

/** unsupported · absent · downloading · downloaded · loading · ready · error — shown in Settings. */
export const gemma = { status: "checking", progress: null, reason: null };

/** Can this browser run it? WebGPU and a GPU with room for the model. */
export async function gemmaSupport() {
  if (!("gpu" in navigator)) return { ok: false, reason: "This browser has no WebGPU — use Chrome or Edge on a laptop or desktop." };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: "No GPU is available to the browser on this device." };
    if (adapter.limits.maxBufferSize < 256 * 1024 * 1024) return { ok: false, reason: "This device's GPU is too small for Gemma." };
  } catch { return { ok: false, reason: "The GPU couldn't be opened." }; }
  if (navigator.deviceMemory && navigator.deviceMemory < 4) return { ok: false, reason: "Gemma needs a device with at least 4 GB of memory." };
  return { ok: true, reason: null };
}

export async function gemmaDownloaded() {
  try { return !!(await (await caches.open(CACHE)).match(DONE)); } catch { return false; }
}

/** Sets `gemma.status` from what this browser can do and what it already has. */
export async function detectGemma() {
  if (["downloading", "loading", "ready"].includes(gemma.status)) return gemma.status;
  if (new URLSearchParams(location.search).has("devicetest")) { gemma.status = "unsupported"; gemma.reason = "a test device without Gemma"; return gemma.status; }
  const s = await gemmaSupport();
  gemma.reason = s.reason;
  gemma.status = !s.ok ? "unsupported" : (await gemmaDownloaded()) ? "downloaded" : "absent";
  return gemma.status;
}

let downloading = null;
/** Downloads the runtime and the model (resumes where it stopped); `onProgress` gets 0–1. */
export function downloadGemma(onProgress) {
  downloading ??= (async () => {
    gemma.status = "downloading"; gemma.progress = 0; onProgress?.(0);
    try {
      await navigator.storage?.persist?.().catch(() => false);
      const cache = await caches.open(CACHE);
      const est = await navigator.storage?.estimate?.().catch(() => null);
      const have = (await cache.keys()).filter(k => k.url.includes(`/gemma-store/${MODEL.id}/`)).length;
      if (est && est.quota - est.usage < (PIECES - have) * PIECE + 64e6) throw new Error("Not enough free space in this browser for Gemma (about 2 GB).");
      for (const url of Object.values(FILES)) if (!(await cache.match(url))) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Couldn't download the Gemma runtime (${r.status}).`);
        await cache.put(url, r);
      }
      for (let i = 0; i < PIECES; i++) {
        if (!(await cache.match(piece(i)))) {
          const start = i * PIECE, end = Math.min(MODEL.size, start + PIECE) - 1;
          const r = await fetch(MODEL.url, { headers: { Range: `bytes=${start}-${end}` } });
          if (r.status !== 206) throw new Error(`The model download was refused (${r.status}). Try again later.`);
          const buf = await r.arrayBuffer();
          if (buf.byteLength !== end - start + 1) throw new Error("The model download was cut short. Tap Download to resume.");
          await cache.put(piece(i), new Response(buf));
        }
        gemma.progress = (i + 1) / PIECES; onProgress?.(gemma.progress);
      }
      await cache.put(DONE, new Response(JSON.stringify({ id: MODEL.id, size: MODEL.size, at: Date.now() })));
      gemma.status = "downloaded"; gemma.progress = null;
    } catch (e) {
      gemma.status = "absent"; gemma.progress = null; gemma.reason = e.message;
      throw e;
    } finally { downloading = null; }
  })();
  return downloading;
}

export async function removeGemma() {
  llm?.close?.(); llm = null; loading = null;
  await caches.delete(CACHE);
  gemma.status = "absent"; gemma.progress = null;
}

let llm = null, loading = null;
/** Loads the downloaded model onto the GPU (a few seconds; once per page). Works offline. */
export function loadGemma() {
  loading ??= (async () => {
    gemma.status = "loading";
    try {
      const cache = await caches.open(CACHE);
      const local = async url => { const r = await cache.match(url); if (!r) throw new Error("Gemma isn't fully downloaded."); return URL.createObjectURL(await r.blob()); };
      const { LlmInference } = await import(await local(FILES.bundle));
      const fileset = { wasmLoaderPath: await local(FILES.loader), wasmBinaryPath: await local(FILES.wasm) };
      // The model streams from storage piece by piece: 2 GB never sits in one buffer.
      let i = 0;
      const stream = new ReadableStream({ async pull(c) {
        if (i >= PIECES) return c.close();
        const r = await cache.match(piece(i++));
        if (!r) return c.error(new Error("A piece of Gemma is missing — download it again."));
        c.enqueue(new Uint8Array(await r.arrayBuffer()));
      } });
      llm = await LlmInference.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: stream.getReader() }, maxTokens: 2048, topK: 1, temperature: 0, randomSeed: 1 });
      gemma.status = "ready";
      return llm;
    } catch (e) { gemma.status = "error"; gemma.reason = e.message; loading = null; throw e; }
  })();
  return loading;
}

let queue = Promise.resolve();
/** One answer at a time (the runtime handles one request at a time). Gemma 4's turn format. */
export function generate(system, user) {
  const run = queue.then(async () => {
    const m = await loadGemma();
    return m.generateResponse(`<|turn>system\n${system}<turn|>\n<|turn>user\n${user}<turn|>\n<|turn>model\n`);
  });
  queue = run.catch(() => {});
  return run;
}
