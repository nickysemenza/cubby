/**
 * Shortcode utilities for generating human-readable entity identifiers.
 *
 * Format: {PREFIX}-{4 chars}
 *   - Locations: L-XXXX
 *   - Products: P-XXXX
 *   - Recipes: R-XXXX
 *
 * Character set excludes ambiguous characters (0/O, 1/I/L) for readability.
 */

import {
  locationShortcode,
  productShortcode,
  recipeShortcode,
} from "~/schemas/identifiers";

// Character set: 32 chars (no 0/O, 1/I/L for clarity)
const CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * Generate a random 4-character ID from the safe character set.
 */
export function generateShortcodeId(): string {
  let result = "";
  for (let i = 0; i < 4; i++) {
    result += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return result;
}

/**
 * Generate a location shortcode (L-XXXX format).
 */
export function generateLocationShortcode(): string {
  return `L-${generateShortcodeId()}`;
}

/**
 * Generate a product shortcode (P-XXXX format).
 */
export function generateProductShortcode(): string {
  return `P-${generateShortcodeId()}`;
}

/**
 * Generate a recipe shortcode (R-XXXX format).
 */
export function generateRecipeShortcode(): string {
  return `R-${generateShortcodeId()}`;
}

/**
 * Parse a shortcode to extract entity type and ID.
 * Returns null if the shortcode is invalid.
 * Uses Zod schemas for validation.
 */
export function parseShortcode(
  code: string,
): { type: "location" | "product" | "recipe"; id: string } | null {
  const normalized = code.trim().toUpperCase();

  if (locationShortcode.safeParse(normalized).success) {
    return { type: "location", id: normalized.slice(2) };
  }
  if (productShortcode.safeParse(normalized).success) {
    return { type: "product", id: normalized.slice(2) };
  }
  if (recipeShortcode.safeParse(normalized).success) {
    return { type: "recipe", id: normalized.slice(2) };
  }
  return null;
}

/**
 * Check if a string is a valid shortcode format.
 */
export function isValidShortcode(code: string): boolean {
  return parseShortcode(code) !== null;
}

/**
 * Extract a shortcode from a raw QR code scan value.
 * Handles both raw shortcodes ("L-A3F2") and full URLs ("https://cubby.example.com/L-A3F2").
 * Returns the normalized uppercase shortcode or null if invalid.
 */
export function extractShortcodeFromScan(rawValue: string): string | null {
  const trimmed = rawValue.trim();

  // Try parsing as a raw shortcode first
  const direct = parseShortcode(trimmed);
  if (direct) return trimmed.toUpperCase();

  // Try parsing as a URL and extracting the last path segment
  try {
    const url = new URL(trimmed);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) {
      const fromUrl = parseShortcode(lastSegment);
      if (fromUrl) return lastSegment.toUpperCase();
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
export function getShortcodeUrl(shortcode: string, baseUrl?: string): string {
  const base =
    baseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/${shortcode}`;
}
