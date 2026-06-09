// Runs INSIDE a hidden react-native-webview (WKWebView). WebKit is a real
// browser — it has WebAssembly (incl. reference-types/externref) and JIT — so the
// exact recipebridge web build runs here unchanged. esbuild bundles this entry
// (glue + base64 WASM) into one self-contained <script> (see scripts/build-recipebridge-host.mjs).
//
// Protocol over react-native-webview messaging:
//   RN  -> host: { type:"call", id, method, args }   (via webviewRef.postMessage)
//   host -> RN : { type:"ready" } | { type:"result", id, ok, result|error } | { type:"error", error }
import * as bg from "@cubby/recipebridge/recipebridge_bg.js";
// esbuild `base64` loader turns the .wasm import into a base64 string.
import wasmB64 from "@cubby/recipebridge/recipebridge_bg.wasm";

function post(msg) {
  // biome-ignore lint/suspicious/noExplicitAny: injected RN bridge global.
  const rnw = /** @type {any} */ (window).ReactNativeWebView;
  if (rnw) rnw.postMessage(JSON.stringify(msg));
}

function invoke(method, args) {
  const fn = bg[method];
  if (typeof fn !== "function") throw new Error(`unknown method: ${method}`);
  return fn(...(args || []));
}

function handle(raw) {
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (!req) return;

  if (req.type === "call") {
    try {
      post({
        type: "result",
        id: req.id,
        ok: true,
        result: invoke(req.method, req.args),
      });
    } catch (err) {
      post({
        type: "result",
        id: req.id,
        ok: false,
        error: String(err?.message ?? err),
      });
    }
    return;
  }

  // One round-trip for many calls: returns a per-call { ok, result|error } array.
  if (req.type === "batch") {
    const result = (req.calls || []).map((c) => {
      try {
        return { ok: true, result: invoke(c.method, c.args) };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });
    post({ type: "result", id: req.id, ok: true, result });
    return;
  }
}

(async () => {
  try {
    const bytes = Uint8Array.from(atob(wasmB64), (c) => c.charCodeAt(0));
    const { instance } = await WebAssembly.instantiate(bytes, {
      "./recipebridge_bg.js": bg,
    });
    bg.__wbg_set_wasm(instance.exports);
    instance.exports.__wbindgen_start?.();
    // iOS fires on window; Android on document — listen to both.
    window.addEventListener("message", (e) => handle(e.data));
    document.addEventListener("message", (e) => handle(e.data));
    post({ type: "ready" });
  } catch (err) {
    post({ type: "error", error: String(err?.message ?? err) });
  }
})();
