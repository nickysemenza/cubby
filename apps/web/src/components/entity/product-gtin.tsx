import { displayGtin } from "@cubby/schemas/external-id";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

/** "ISBN-13" when the stored GTIN-14 encodes a book barcode, else "UPC". */
export function productGtinLabel(gtin: string | null): "ISBN-13" | "UPC" {
  return gtin !== null && wasm.isbn_from_gtin(gtin) ? "ISBN-13" : "UPC";
}

/**
 * A product's primary barcode as the printed encoding, not the stored GTIN-14:
 * the operator compares it against the package, and the USDA page is keyed
 * the same way. A book barcode reads as its ISBN-13 (no USDA page to link).
 */
export function ProductGtin({
  gtin,
  className,
}: {
  gtin: string;
  className?: string;
}) {
  const isbn = wasm.isbn_from_gtin(gtin);
  if (isbn) {
    return (
      <span className={cn("font-mono tabular-nums", className)}>
        {isbn.isbn13}
      </span>
    );
  }
  const shown = displayGtin(gtin);
  return (
    <Link
      to="/usda/upc/$code"
      params={{ code: shown }}
      className={cn("font-mono text-primary hover:underline", className)}
    >
      {shown}
    </Link>
  );
}
