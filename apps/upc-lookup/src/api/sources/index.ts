import { UPC_SOURCE_NAMES } from "@cubby/upc-contract";
import type { ProductSource } from "./types";
import { upcitemdb } from "./upcitemdb";

export type { ProductSource } from "./types";

/**
 * The ordered source registry — the single source of truth for where product
 * data comes from. `lookupExternalProduct` (see ../index.ts) tries each in
 * order and returns the first non-null hit.
 *
 * To add a source: implement the {@link ProductSource} interface in its own
 * module and append it here. The `source` type ({@link SourceName}) and the
 * Zod enum ({@link SOURCE_NAMES}) both derive from this array, so they update
 * automatically — no other edits needed.
 */
export const SOURCES = [upcitemdb] as const satisfies readonly ProductSource[];

/**
 * Every valid value of the `source` column: the registered source names plus
 * `"manual"` for admin/MCP-created rows that didn't come from a lookup.
 */
export type SourceName = (typeof UPC_SOURCE_NAMES)[number];

/**
 * Runtime tuple of valid source values, for building the Zod enum. `"manual"`
 * leads so the tuple is statically non-empty (`[string, ...string[]]`); order
 * is irrelevant to enum membership.
 */
export const SOURCE_NAMES = UPC_SOURCE_NAMES;
