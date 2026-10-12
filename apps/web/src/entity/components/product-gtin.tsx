import { displayGtin } from "@cubby/schemas/external-id";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { MiddleTruncate } from "~/ui/common/middle-truncate";
import { useDenseCell } from "~/ui/common/stacked-value";

/** "ISBN-13" when the stored GTIN-14 encodes a book barcode, else "UPC". */
export function productGtinLabel(gtin: string | null): "ISBN-13" | "UPC" {
  return gtin !== null && wasm.isbn_from_gtin(gtin) ? "ISBN-13" : "UPC";
}

/**
 * A product's primary barcode as the printed encoding, not the stored GTIN-14:
 * the operator compares it against the package, and the USDA page is keyed
 * the same way. A book barcode reads as its ISBN-13 (no USDA page to link).
 * A table cell keeps its first and last four digits when it is narrow.
 */
export function ProductGtin({
  gtin,
  className,
}: {
  gtin: string;
  className?: string;
}) {
  const dense = useDenseCell();
  const isbn = wasm.isbn_from_gtin(gtin);
  if (isbn) {
    return dense ? (
      <MiddleTruncate
        text={isbn.isbn13}
        className={cn("font-mono tabular-nums", className)}
      />
    ) : (
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
      className={cn(
        "inline-flex max-w-full min-w-0 font-mono text-primary hover:underline",
        className,
      )}
    >
      {dense ? <MiddleTruncate text={shown} /> : shown}
    </Link>
  );
}
