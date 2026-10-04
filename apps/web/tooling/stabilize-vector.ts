import { z } from "zod";

const UUID =
  /"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/giu;
const SHORTCODE = /"([A-Z]+)-[2-9A-HJKMNP-Z]{4,5}"/gu;
const INSTANT = /"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z"/gu;
const SOURCE_KEY = /"v1:[0-9a-f]{64}"/gu;

/**
 * Replaces everything a database mints (ids, shortcodes, instants, hashed claim keys) with stable
 * synthetic values, numbered by first appearance per kind, so a payload read from a real record
 * can be pinned in a golden vector. Every other string passes through.
 */
export const stabilize = (payload: z.core.util.JSONType) => {
  const seen = new Map<string, string>();
  const stable = (raw: string, kind: string, make: (n: number) => string) => {
    const key = `${kind}:${raw}`;
    if (!seen.has(key)) {
      const count = [...seen.keys()].filter((k) => k.startsWith(`${kind}:`));
      seen.set(key, make(count.length + 1));
    }
    return seen.get(key) ?? raw;
  };
  const text = JSON.stringify(payload)
    .replaceAll(UUID, (raw) =>
      stable(
        raw,
        "uuid",
        (n) => `"${String(n).padStart(8, "0")}-0000-4000-8000-000000000000"`,
      ),
    )
    // Digits 2-9 are in the shortcode alphabet, so `RCP-2222` is a valid code.
    .replaceAll(SHORTCODE, (raw, prefix: string) =>
      stable(raw, prefix, (n) => `"${prefix}-${String(n + 1).repeat(4)}"`),
    )
    .replaceAll(SOURCE_KEY, (raw) =>
      stable(raw, "key", (n) => `"v1:${String(n).padStart(64, "0")}"`),
    )
    .replaceAll(INSTANT, '"2026-01-01T00:00:00.000Z"');
  return z.json().parse(JSON.parse(text));
};

/** A value as it crosses the wire: `Date`s become instants, `undefined` keys drop. */
export const wireJson = <Value>(value: Value) =>
  z.json().parse(JSON.parse(JSON.stringify(value)));
