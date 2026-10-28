// Both production and worker tests receive a compiled module from workerd's
// bundler. Keep wasm-bindgen's binding handshake in this single adapter.
import * as bindings from "./worker/recipebridge_bg.js";
import module from "./worker/recipebridge_bg.wasm";

let instance;
const exportsOnDemand = () => {
  if (instance) return instance.exports;
  instance = new WebAssembly.Instance(module, {
    "./recipebridge_bg.js": bindings,
  });
  // Start imports may access memory/externrefs. Install the real exports
  // before starting so they cannot recursively instantiate the module.
  bindings.__wbg_set_wasm(instance.exports);
  if (typeof instance.exports.__wbindgen_start !== "function") {
    throw new Error("recipebridge WASM is missing its start export");
  }
  instance.exports.__wbindgen_start();
  return instance.exports;
};

// wasm-bindgen's functions access exports only when called. Importing the
// capability surface no longer initializes WASM on unrelated Worker paths.
bindings.__wbg_set_wasm(
  new Proxy(
    {},
    {
      get: (_target, key) => exportsOnDemand()[key],
    },
  ),
);

export * from "./worker/recipebridge_bg.js";
