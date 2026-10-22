// Both production and worker tests receive a compiled module from workerd's
// bundler. Keep wasm-bindgen's binding handshake in this single adapter.
import * as bindings from "./worker/recipebridge_bg.js";
import module from "./worker/recipebridge_bg.wasm";

const instance = new WebAssembly.Instance(module, {
  "./recipebridge_bg.js": bindings,
});
bindings.__wbg_set_wasm(instance.exports);
if (typeof instance.exports.__wbindgen_start !== "function") {
  throw new Error("recipebridge WASM is missing its start export");
}
instance.exports.__wbindgen_start();

export * from "./worker/recipebridge_bg.js";
