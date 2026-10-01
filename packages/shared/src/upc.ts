import { z } from "zod";

/** The shape of a barcode: EAN-8, UPC-A, EAN-13 or GTIN-14 digits. */
export const BARCODE_RE = /^\d{8}$|^\d{12,14}$/;

/**
 * Is `value` an 8/12/13/14 digit barcode whose last digit is its GS1 check
 * digit (mod-10, weights x3/x1 alternating from the digit beside the check)?
 *
 * Pure-TS twin of `recipebridge`'s `is_valid_gtin` (wasm/FFI is canonical; this
 * package cannot call it). Both read `golden-vectors/gtin.json`.
 */
export const isGtin = (value: string): boolean => {
  if (!BARCODE_RE.test(value)) return false;
  let sum = 0;
  for (let index = value.length - 2, weight = 3; index >= 0; index--) {
    sum += Number(value[index]) * weight;
    weight = 4 - weight;
  }
  return (10 - (sum % 10)) % 10 === Number(value[value.length - 1]);
};

export const BARCODE_CHECK_DIGIT_MESSAGE =
  "Barcode check digit does not match; re-scan or re-type it";

export const upc = z
  .string()
  .trim()
  .regex(BARCODE_RE, {
    message: "Barcode must be 8, 12, 13, or 14 digits",
    abort: true,
  })
  .refine(isGtin, BARCODE_CHECK_DIGIT_MESSAGE)
  .describe("EAN-8 (8), UPC-A (12), EAN-13 (13), or GTIN-14 (14) barcode");
