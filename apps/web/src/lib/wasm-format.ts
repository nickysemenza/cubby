// The shared Rust value formatters (recipebridge `display_format`), the same
// code native calls through UniFFI. Deliberately not routed through `~/lib/wasm`:
// that proxy wraps every call in a trace span and (for cached methods) a
// JSON-keyed LRU lookup, both far costlier than these microsecond-scale pure
// functions called once per table cell.
import type * as RecipeBridge from "@cubby/recipebridge";

const bridge: typeof RecipeBridge = await import("@cubby/recipebridge");

export const {
  format_currency,
  format_number,
  format_compact_number,
  format_compact_estimate,
} = bridge;
