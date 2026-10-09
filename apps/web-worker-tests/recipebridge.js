// `@cubby/recipebridge` for the Workers pool. wasm-bindgen's bundler output
// imports the `.wasm` file as an ES module namespace (WebAssembly ESM
// integration), which the Worker build supports and the pool does not: there
// the import is a compiled `WebAssembly.Module`. Instantiate it the way the
// generated glue expects, then re-export the glue.
import * as glue from "../../packages/wasm/worker/recipebridge_bg.js";
import compiled from "../../packages/wasm/worker/recipebridge_bg.wasm";

const instance = new WebAssembly.Instance(compiled, {
  "./recipebridge_bg.js": glue,
});
glue.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();

export * from "../../packages/wasm/worker/recipebridge_bg.js";
