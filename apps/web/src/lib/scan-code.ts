import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ProductFindOrCreateByCodeInput } from "@cubby/schemas/product";
import type { ScanAtLocationCode } from "@cubby/schemas/scan";
import type { ShortcodeType } from "@cubby/shared";
import { extractShortcodeFromScan } from "@cubby/shared";
import { upc } from "@cubby/usda-schemas";

import { wasm } from "~/lib/wasm";

export type ResolvedScanCode =
  /**
   * `type` rides along because every caller needs it: a location-only scanner
   * has to reject a `PRD-` label, and the sweep routes on it. Re-deriving it
   * from the shortcode string is what spawned the duplicate resolvers.
   */
  | { kind: "shortcode"; shortcode: string; type: ShortcodeType }
  | {
      kind: "product";
      /** Always a concrete code: the raw `scan` arm is what this resolves. */
      code: Exclude<ProductFindOrCreateByCodeInput, { kind: "scan" }>;
    };

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
    const url = new URL(value);
    void url;
    return {
      ok: false,
      error: "That QR code is a web link, not a Cubby label.",
    };
  } catch {
    // SILENT: `new URL(value)` throwing means `value` isn't a URL at all —
    // that's the normal case, so fall through to the barcode/ISBN checks.
  }

  const normalizedIsbn = wasm.normalize_isbn(value);
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

/**
 * Narrow a scan to one surface's scope.
 *
 * `resolveScanCode` deliberately returns the whole union so callers can route
 * on `type`, but "may I have this?" is a different question from "what is
 * this?", and four surfaces had each answered it themselves — producing three
 * different sentences for the single condition "that is not a location". These
 * two helpers own the answer, and with it the rejection copy: the helper knows
 * both what was scanned and what was wanted, so it can say which is which where
 * a caller-supplied string could only ever name the want.
 */
/** A product scan resolved to one concrete code: never the raw `scan` arm. */
export type ResolvedProductCode = Exclude<ScanAtLocationCode, { kind: "scan" }>;

export type ScopedScan<T> =
  | { ok: true; value: T }
  /**
   * `reason` separates "that is not a code at all" from "that is a code for the
   * wrong thing". Surfaces that accept more than a scan can name — the location
   * field also takes a pasted UUID — need to try their extra forms before
   * reporting, and only they can word the catch-all.
   */
  | { ok: false; reason: "unrecognized" | "wrong-kind"; error: string };

/** A scan that must name a location: bin labels, and nothing else. */
export function resolveLocationScan(raw: string): ScopedScan<string> {
  const parsed = resolveScanCode(raw);
  if (!parsed.ok) {
    return { ok: false, reason: "unrecognized", error: parsed.error };
  }

  if (parsed.value.kind === "product") {
    return {
      ok: false,
      reason: "wrong-kind",
      error: "That's a product barcode — point at a location QR.",
    };
  }
  if (parsed.value.type !== "location") {
    return {
      ok: false,
      reason: "wrong-kind",
      error: `That's a ${parsed.value.type} label — point at a location QR.`,
    };
  }
  return { ok: true, value: parsed.value.shortcode };
}

/**
 * A scan that must name something stockable at a location.
 *
 * Cubby's own product labels are QR and the sweep reads QR, so a printed `PRD-`
 * label has to work here — rejecting it would make the label useless on the one
 * screen most likely to see it.
 */
export function resolveProductScan(
  raw: string,
): ScopedScan<ResolvedProductCode> {
  const parsed = resolveScanCode(raw);
  if (!parsed.ok) {
    return { ok: false, reason: "unrecognized", error: parsed.error };
  }

  if (parsed.value.kind === "product") {
    return { ok: true, value: parsed.value.code };
  }
  if (parsed.value.type === "product") {
    return {
      ok: true,
      value: {
        kind: "product",
        value: parseShortcodeFor("product", parsed.value.shortcode),
      },
    };
  }
  return {
    ok: false,
    reason: "wrong-kind",
    error: `That's a ${parsed.value.type} label — nothing that sits on a shelf.`,
  };
}
