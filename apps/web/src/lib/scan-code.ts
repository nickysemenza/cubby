import { normalizeIsbn } from "@cubby/schemas/isbn";
import type { ProductFindOrCreateByCodeInput } from "@cubby/schemas/product";
import type { ShortcodeType } from "@cubby/shared";
import { extractShortcodeFromScan } from "@cubby/shared";
import { upc } from "@cubby/usda-schemas";

export type ResolvedScanCode =
  /**
   * `type` rides along because every caller needs it: a location-only scanner
   * has to reject a `PRD-` label, and the sweep routes on it. Re-deriving it
   * from the shortcode string is what spawned the duplicate resolvers.
   */
  | { kind: "shortcode"; shortcode: string; type: ShortcodeType }
  | { kind: "product"; code: ProductFindOrCreateByCodeInput };

export type ScanCodeResolution =
  | { ok: true; value: ResolvedScanCode }
  | { ok: false; error: string };

/**
 * Classify one camera/manual scanner value without performing I/O.
 *
 * Cubby label URLs stay on the current deployment by extracting their
 * shortcode instead of opening the encoded production URL. ISBN is checked
 * before generic EAN because every ISBN-13 is also a valid product barcode,
 * but its book semantics change how a missing Product is created.
 */
export function resolveScanCode(raw: string): ScanCodeResolution {
  const value = raw.trim();
  if (!value) {
    return {
      ok: false,
      error: "Enter or scan a Cubby code, barcode, or ISBN.",
    };
  }

  const shortcode = extractShortcodeFromScan(value);
  if (shortcode) {
    return {
      ok: true,
      value: {
        kind: "shortcode",
        shortcode: shortcode.shortcode,
        type: shortcode.type,
      },
    };
  }

  try {
    new URL(value);
    return {
      ok: false,
      error: "That QR code is a web link, not a Cubby label.",
    };
  } catch {
    // Plain codes are the normal path.
  }

  const normalizedIsbn = normalizeIsbn(value);
  if (normalizedIsbn) {
    return {
      ok: true,
      value: {
        kind: "product",
        code: { kind: "isbn", value: normalizedIsbn.gtin14 },
      },
    };
  }

  const barcode = upc.safeParse(value);
  if (barcode.success) {
    return {
      ok: true,
      value: {
        kind: "product",
        code: { kind: "barcode", value: barcode.data },
      },
    };
  }

  return {
    ok: false,
    error: "Use a Cubby shortcode, UPC/EAN/GTIN barcode, or valid ISBN.",
  };
}
