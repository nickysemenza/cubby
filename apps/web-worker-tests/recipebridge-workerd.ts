// @ts-nocheck — wasm-bindgen generated JS has no type declarations
// The calendar test worker's @cubby/recipebridge. workerd imports a `.wasm`
// module as an uninstantiated WebAssembly.Module; the `?init` form that
// apps/web/src/lib/recipebridge-cf.ts uses is a @cloudflare/vite-plugin
// feature this Vitest plugin does not resolve. Instantiate it the same way.

import * as bg from "../../packages/wasm/worker/recipebridge_bg.js";
import wasmModule from "../../packages/wasm/worker/recipebridge_bg.wasm";

const instance = new WebAssembly.Instance(wasmModule, {
  "./recipebridge_bg.js": bg,
});
bg.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();

export * from "../../packages/wasm/worker/recipebridge_bg.js";
