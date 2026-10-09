import recipebridgeWasmUrl from "../../../../packages/wasm/browser/recipebridge_bg.wasm?url";

/**
 * Starts the recipebridge download from the document head instead of after
 * the route's JS graph evaluates `lib/wasm`. The attributes match the plugin
 * loader's `fetch(url)` (CORS mode, same-origin credentials) so the browser
 * reuses the preloaded response rather than downloading twice.
 */
export const recipebridgeWasmPreload = {
  rel: "preload",
  href: recipebridgeWasmUrl,
  as: "fetch",
  type: "application/wasm",
  crossOrigin: "anonymous",
} as const;
