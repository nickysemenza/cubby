import { customAlphabet } from "nanoid";
import { z } from "zod";

/** Character set: 32 chars (no 0/O, 1/I/L for clarity) */
export const SHORTCODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const shortcodePattern = `[${SHORTCODE_CHARS}]{4}`;

/**
 * Per-entity shortcode prefixes — the single source of truth for the "X-" stamp.
 * Everything below (the validators, the all-prefix regex, the parser map, and
 * the generators) derives from this, so a prefix is defined exactly once.
 */
export const SHORTCODE_PREFIX = {
  location: "L-",
  product: "P-",
  recipe: "R-",
} as const;
export type ShortcodeType = keyof typeof SHORTCODE_PREFIX;

const prefixLetters = Object.values(SHORTCODE_PREFIX)
  .map((p) => p.charAt(0))
  .join("");
const shortcodeRegex = (type: ShortcodeType) =>
  new RegExp(`^${SHORTCODE_PREFIX[type]}${shortcodePattern}$`);

/** Regex matching any valid shortcode (L-XXXX, P-XXXX, R-XXXX) */
export const SHORTCODE_RE = new RegExp(
  `^([${prefixLetters}])-${shortcodePattern}$`,
);

// Zod schemas with brand types for compile-time safety
export const locationShortcode = z
  .string()
  .regex(shortcodeRegex("location"), "Invalid location shortcode")
  .brand("LocationShortcode");

export const productShortcode = z
  .string()
  .regex(shortcodeRegex("product"), "Invalid product shortcode")
  .brand("ProductShortcode");

export const recipeShortcode = z
  .string()
  .regex(shortcodeRegex("recipe"), "Invalid recipe shortcode")
  .brand("RecipeShortcode");

export type LocationShortcode = z.infer<typeof locationShortcode>;
export type ProductShortcode = z.infer<typeof productShortcode>;
export type RecipeShortcode = z.infer<typeof recipeShortcode>;

const PREFIX_MAP: Record<string, ShortcodeType> = Object.fromEntries(
  (Object.keys(SHORTCODE_PREFIX) as ShortcodeType[]).map((type) => [
    SHORTCODE_PREFIX[type].charAt(0),
    type,
  ]),
);

const shortcodeId = customAlphabet(SHORTCODE_CHARS, 4);

/** Generate a random 4-character ID from the safe character set. */
export function generateShortcodeId(): string {
  return shortcodeId();
}

/** Generate a location shortcode (L-XXXX format). */
export function generateLocationShortcode(): string {
  return `${SHORTCODE_PREFIX.location}${generateShortcodeId()}`;
}

/** Generate a product shortcode (P-XXXX format). */
export function generateProductShortcode(): string {
  return `${SHORTCODE_PREFIX.product}${generateShortcodeId()}`;
}

/** Generate a recipe shortcode (R-XXXX format). */
export function generateRecipeShortcode(): string {
  return `${SHORTCODE_PREFIX.recipe}${generateShortcodeId()}`;
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

  const prefix = match[1];
  const type = prefix ? PREFIX_MAP[prefix] : undefined;
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
