import { z } from "zod";

/** Character set: 32 chars (no 0/O, 1/I/L for clarity) */
export const SHORTCODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const shortcodePattern = `[${SHORTCODE_CHARS}]{4}`;

/** Regex matching any valid shortcode (L-XXXX, P-XXXX, R-XXXX) */
export const SHORTCODE_RE = new RegExp(`^([LPR])-${shortcodePattern}$`);

// Zod schemas with brand types for compile-time safety
export const locationShortcode = z
  .string()
  .regex(new RegExp(`^L-${shortcodePattern}$`), "Invalid location shortcode")
  .brand("LocationShortcode");

export const productShortcode = z
  .string()
  .regex(new RegExp(`^P-${shortcodePattern}$`), "Invalid product shortcode")
  .brand("ProductShortcode");

export const recipeShortcode = z
  .string()
  .regex(new RegExp(`^R-${shortcodePattern}$`), "Invalid recipe shortcode")
  .brand("RecipeShortcode");

export type LocationShortcode = z.infer<typeof locationShortcode>;
export type ProductShortcode = z.infer<typeof productShortcode>;
export type RecipeShortcode = z.infer<typeof recipeShortcode>;

type ShortcodeType = "location" | "product" | "recipe";

const PREFIX_MAP: Record<string, ShortcodeType> = {
  L: "location",
  P: "product",
  R: "recipe",
};

/** Generate a random 4-character ID from the safe character set. */
export function generateShortcodeId(): string {
  let result = "";
  for (let i = 0; i < 4; i++) {
    result +=
      SHORTCODE_CHARS[Math.floor(Math.random() * SHORTCODE_CHARS.length)];
  }
  return result;
}

/** Generate a location shortcode (L-XXXX format). */
export function generateLocationShortcode(): string {
  return `L-${generateShortcodeId()}`;
}

/** Generate a product shortcode (P-XXXX format). */
export function generateProductShortcode(): string {
  return `P-${generateShortcodeId()}`;
}

/** Generate a recipe shortcode (R-XXXX format). */
export function generateRecipeShortcode(): string {
  return `R-${generateShortcodeId()}`;
}

/**
 * Parse a shortcode to extract entity type and ID.
 * Returns both the full shortcode ("L-A3F2") and just the id part ("A3F2").
 */
export function parseShortcode(
  code: string,
): { type: ShortcodeType; shortcode: string; id: string } | null {
  const normalized = code.trim().toUpperCase();
  const match = normalized.match(SHORTCODE_RE);
  if (!match) return null;

  const type = PREFIX_MAP[match[1]];
  if (!type) return null;

  return { type, shortcode: normalized, id: normalized.slice(2) };
}

/** Check if a string is a valid shortcode format. */
export function isValidShortcode(code: string): boolean {
  return parseShortcode(code) !== null;
}

/**
 * Extract a shortcode from a raw QR code scan value.
 * Handles both raw shortcodes ("L-A3F2") and full URLs ("https://cubby.example.com/L-A3F2").
 */
export function extractShortcodeFromScan(
  rawValue: string,
): { type: ShortcodeType; shortcode: string; id: string } | null {
  const trimmed = rawValue.trim();

  // Try parsing as a raw shortcode first
  const direct = parseShortcode(trimmed);
  if (direct) return direct;

  // Try parsing as a URL and extracting the last path segment
  try {
    const url = new URL(trimmed);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) {
      return parseShortcode(lastSegment);
    }
  } catch {
    // Not a valid URL
  }

  return null;
}

/**
 * Build the full URL for a shortcode (used in QR codes).
 * Uses the shortcode directly in the path: /L-XXXX or /P-XXXX
 */
export function getShortcodeUrl(shortcode: string): string {
  return `https://cubby.nickysemenza.com/${shortcode}`;
}
