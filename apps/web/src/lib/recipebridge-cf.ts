// @ts-nocheck — wasm-bindgen generated JS has no type declarations
// CF Workers wrapper for @cubby/recipebridge.
// The wasm-bindgen "bundler" target expects the bundler to instantiate the WASM
// module, but the Cloudflare Vite plugin doesn't do this. This wrapper uses the
// ?init pattern (supported by @cloudflare/vite-plugin) to manually instantiate
// the WASM module with the correct JS bindings.

import * as bg from "../../../../packages/wasm/recipebridge_bg.js";
import initWasm from "../../../../packages/wasm/recipebridge_bg.wasm?init";

// Instantiate WASM with the JS bindings it imports from _bg.js
const instance: WebAssembly.Instance = await initWasm({
  "./recipebridge_bg.js": bg,
});

// Close the circular dependency: set the WASM exports ref in the bg module
bg.__wbg_set_wasm(instance.exports);

// Run the wasm-bindgen start function
(instance.exports as Record<string, CallableFunction>).__wbindgen_start();

// Re-export the public API (same exports as @cubby/recipebridge)
export * from "../../../../packages/wasm/recipebridge_bg.js";
