import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { MiddleTruncate } from "~/ui/common/middle-truncate";
import { useDenseCell } from "~/ui/common/stacked-value";

/** Canonical storage establishes ISBN identity, but not an observed UPC/EAN encoding. */
export function productGtinLabel(gtin: string | null): "ISBN-13" | "GTIN" {
  return gtin !== null && wasm.isbn_from_gtin(gtin) ? "ISBN-13" : "GTIN";
}

export function ProductGtin({
  gtin,
  className,
}: {
  gtin: string;
  className?: string;
}) {
  const dense = useDenseCell();
  const shown = wasm.isbn_from_gtin(gtin)?.isbn13 ?? gtin;
  return dense ? (
    <MiddleTruncate
      code
      text={shown}
      className={cn("font-mono tabular-nums", className)}
    />
  ) : (
    <span className={cn("font-mono tabular-nums", className)}>{shown}</span>
  );
}
