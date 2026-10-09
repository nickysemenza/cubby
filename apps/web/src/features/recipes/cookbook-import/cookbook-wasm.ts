type CookbookWasm = typeof import("@cubby/recipebridge/cookbook");

/** What the importer needs from the EPUB package; tests pass a faithful stand-in. */
export type LoadCookbookWasm = () => Promise<Pick<CookbookWasm, "open_book">>;

let loading: Promise<CookbookWasm> | undefined;

/**
 * The EPUB pipeline is its own wasm package (~0.9 MB gzip) so only this import
 * flow downloads it; the Worker and every other page load recipebridge
 * without it. A failed load is retried on the next call.
 */
export function loadCookbookWasm(): Promise<CookbookWasm> {
  // Keeps the package out of the SSR graph, and so out of the Worker upload.
  if (import.meta.env.SSR)
    return Promise.reject(new Error("Cookbook EPUBs open only in the browser"));
  if (loading) return loading;
  const attempt = import("@cubby/recipebridge/cookbook");
  loading = attempt;
  void attempt.catch(() => {
    // SILENT: the caller receives the same rejection from `attempt`.
    if (loading === attempt) loading = undefined;
  });
  return attempt;
}
