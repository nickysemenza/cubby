import { z } from "zod";

export const BARCODE_RE = /^\d{8}$|^\d{12,14}$/;

export const upc = z
  .string()
  .trim()
  .regex(BARCODE_RE, "Barcode must be 8, 12, 13, or 14 digits")
  .describe("EAN-8 (8), UPC-A (12), EAN-13 (13), or GTIN-14 (14) barcode");
