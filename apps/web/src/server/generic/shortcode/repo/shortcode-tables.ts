import type { ShortcodeType } from "@cubby/shared";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { SHORTCODE_TABLE as GENERATED_SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";

/** A table carrying a public shortcode column. */
export type ShortcodeTable = PgTable & {
  id: PgColumn;
  shortcode: PgColumn;
  deletedAt?: PgColumn;
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

/** Cross-kind payload locks precede identity locks. Parents precede children;
 * the remaining kinds have a deterministic order shared by all publishers. */
export function orderedEntityLockKinds<T extends string>(
  kinds: readonly T[],
): T[] {
  const parents = [
    "purchase",
    "project",
    "location",
    "cookbook",
    "device",
    "task",
    "product",
  ];
  const rank = (kind: string) => {
    const index = parents.indexOf(kind);
    return index < 0 ? parents.length : index;
  };
  return [...new Set(kinds)].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
}
