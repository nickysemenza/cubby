/**
 * Standalone shortcode parsing for mobile app (no Zod dependency).
 * Mirrors logic from apps/web/src/lib/shortcode.ts.
 */

const SHORTCODE_RE = /^([LPR])-([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4})$/;

type ShortcodeType = "location" | "product" | "recipe";

const PREFIX_MAP: Record<string, ShortcodeType> = {
  L: "location",
  P: "product",
  R: "recipe",
};

export function parseShortcode(
  code: string,
): { type: ShortcodeType; shortcode: string } | null {
  const normalized = code.trim().toUpperCase();
  const match = normalized.match(SHORTCODE_RE);
  if (!match) return null;

  const type = PREFIX_MAP[match[1]];
  if (!type) return null;

  return { type, shortcode: normalized };
}

/**
 * Extract a shortcode from a raw QR code scan value.
 * Handles both raw shortcodes ("L-A3F2") and full URLs ("https://cubby.example.com/L-A3F2").
 */
export function extractShortcodeFromScan(
  rawValue: string,
): { type: ShortcodeType; shortcode: string } | null {
  const trimmed = rawValue.trim();

  // Try raw shortcode first
  const direct = parseShortcode(trimmed);
  if (direct) return direct;

  // Try as URL — extract last path segment
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
