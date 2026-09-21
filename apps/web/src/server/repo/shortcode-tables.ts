import type { ShortcodeType } from "@cubby/shared";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { SHORTCODE_TABLE as GENERATED_SHORTCODE_TABLE } from "./generated/shortcode-tables.gen";

/** A table carrying a public shortcode column. */
export type ShortcodeTable = PgTable & {
  id: PgColumn;
  shortcode: PgColumn;
  deletedAt: PgColumn;
};

/**
 * The manifest-generated shortcode table registry. Keep this module free of
 * repository helpers so readers and writers can share it without a cycle.
 */
export const SHORTCODE_TABLE = GENERATED_SHORTCODE_TABLE satisfies Record<
  ShortcodeType,
  ShortcodeTable
>;

export type ShortcodeTableFor<T extends ShortcodeType> =
  (typeof SHORTCODE_TABLE)[T];
