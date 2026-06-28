import { BARCODE_RE } from "@cubby/usda-schemas";

/** A valid product barcode: 8, 12, 13, or 14 digits. */
export const UPC_REGEX = BARCODE_RE;
