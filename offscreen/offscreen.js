// Offscreen document — runs the all-MiniLM-L6-v2 sentence-embedding model via
// Transformers.js (ONNX/WASM). The service worker messages here with a batch of
// skill phrases and gets back one normalized vector per phrase. Cosine similarity
// is computed back in the SW.
//
// Why offscreen and not the SW: MV3 service workers are killed after ~30s idle and
// have a tight memory budget — loading a 23MB model there would reload constantly.
// The offscreen doc persists while the SW is alive and the browser caches the model.

import { pipeline, env } from "../lib/transformers.min.js";

// Pull model files from the HF hub (cached in browser Cache Storage after first run).
env.allowLocalModels = false;
// ONNX runtime WASM binaries — fetched as data from jsdelivr (matches lib version).
env.backends.onnx.wasm.wasmPaths =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/";
// Single-threaded: avoids spawning blob: web workers, which the extension CSP blocks.
env.backends.onnx.wasm.numThreads = 1;

// Lazily build the feature-extraction pipeline once; reuse across messages.
// Tracks whether the model has fully loaded so the SW can surface a loading state.
let extractorPromise = null;
let modelReady = false;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "q8", // 8-bit quantized — smaller download, fine for short skill phrases
    }).then(ext => {
      modelReady = true;
      // Notify the SW so the popup can clear any "loading model" status.
      chrome.runtime.sendMessage({ target: "sw", type: "MODEL_READY" }).catch(() => {});
      return ext;
    });
  }
  return extractorPromise;
}

// Warm up the model immediately so the first score request doesn't pay the
// download cost — model files are cached in browser Cache Storage after this.
getExtractor().catch(() => {});

// Parse a résumé PDF (base64) → full text + mailto:/tel: link targets. pdf.js is
// loaded here as a classic script (window.pdfjsLib); the Dice content-script
// world fails to register it, so parsing is delegated to this offscreen page.
async function parsePdfB64(b64) {
  const lib = globalThis.pdfjsLib;
  if (!lib) throw new Error("pdfjsLib not loaded in offscreen");
  lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pdf = await lib.getDocument({ data: bytes }).promise;
  let out = "";
  let links = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map(it => it.str).join(" ") + "\n";
    try {
      for (const a of await page.getAnnotations()) {
        const u = a && a.url;
        if (typeof u === "string" && /^(mailto:|tel:)/i.test(u)) {
          links += " " + u.replace(/^(mailto:|tel:)/i, "").split("?")[0];
        }
      }
    } catch (_) { /* best-effort */ }
  }
  return { text: out.trim(), links: links.trim(), pages: pdf.numPages };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === "offscreen-embed-status") {
    sendResponse({ ok: true, ready: modelReady });
    return true;
  }
  if (message?.target === "offscreen-pdf") {
    parsePdfB64(message.b64)
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
  if (message?.target !== "offscreen-embed") return; // not for us
  (async () => {
    try {
      const texts = message.texts || [];
      if (texts.length === 0) {
        sendResponse({ ok: true, vectors: [] });
        return;
      }
      const extractor = await getExtractor();
      // mean pooling + L2 normalize → vectors directly comparable by cosine/dot.
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      sendResponse({ ok: true, vectors: out.tolist() });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async sendResponse
});
