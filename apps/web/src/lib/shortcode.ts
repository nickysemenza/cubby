/**
 * Shortcode utilities for generating human-readable entity identifiers.
 *
 * Format: {PREFIX}-{4 chars}
 *   - Locations: L-XXXX
 *   - Products: P-XXXX
 *
 * Character set excludes ambiguous characters (0/O, 1/I/L) for readability.
 */

import { locationShortcode, productShortcode } from "~/schemas/identifiers";

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
 * Parse a shortcode to extract entity type and ID.
 * Returns null if the shortcode is invalid.
 * Uses Zod schemas for validation.
 */
export function parseShortcode(
  code: string,
): { type: "location" | "product"; id: string } | null {
  const normalized = code.trim().toUpperCase();

  if (locationShortcode.safeParse(normalized).success) {
    return { type: "location", id: normalized.slice(2) };
  }
  if (productShortcode.safeParse(normalized).success) {
    return { type: "product", id: normalized.slice(2) };
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
 * Build the full URL for a shortcode (used in QR codes).
 * Uses the shortcode directly in the path: /L-XXXX or /P-XXXX
 */
export function getShortcodeUrl(shortcode: string, baseUrl?: string): string {
  const base =
    baseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/${shortcode}`;
}
