import { upc } from "@cubby/shared/upc";

import { wasm } from "~/lib/wasm";

/** Provider spelling preserves observed GTIN width; known book identity uses ISBN-13. */
export function barcodeForLookup(raw: string): string {
  const compact = raw.replace(/[\s-]/gu, "");
  return (
    wasm.normalize_isbn(raw)?.isbn13 ??
    wasm.isbn_from_gtin(compact)?.isbn13 ??
    upc.parse(compact)
  );
}
