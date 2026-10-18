import type { GeneratedListTermKey } from "@cubby/schemas/entity-list-fields";

import { wasm } from "~/lib/wasm";

/**
 * Term expanders a text filter names with `terms` (#2607): each maps the
 * trimmed input to the terms the filter ORs as contains-matches. The key
 * union is generated from the declarations, so a declared key without an
 * expander, or an expander no filter declares, fails typecheck.
 */
export const listTermExpanders = {
  // A barcode in every encoding a person might type: the digits read off a
  // package are usually a suffix of the stored GTIN-14.
  productCode: (term) => [...new Set(wasm.product_code_search_terms(term))],
} satisfies Record<GeneratedListTermKey, (term: string) => readonly string[]>;
