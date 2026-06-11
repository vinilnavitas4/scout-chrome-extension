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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === "offscreen-embed-status") {
    sendResponse({ ok: true, ready: modelReady });
    return true;
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
