import type { ScoredEntity } from "@cubby/schemas/data-quality";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/** The columns every scored table exposes to the generic SQL and hydration. */
export type ScoredTable = PgTable & {
  id: AnyColumn;
  shortcode: AnyColumn;
  deletedAt?: AnyColumn;
};

/** Immutable records have no tombstone column. */
export const liveQualityRow = (t: ScoredTable): SQL =>
  t.deletedAt ? sql`${t.deletedAt} IS NULL` : sql`TRUE`;

/** Statement-local evidence explicitly requested by a caller. */
export type QualityReadContext = {
  /** Unsupported fields return undefined to retain their canonical scalar read. */
  readonly derivedValue?: (
    field: string,
    entityId: AnyColumn,
  ) => SQL | undefined;
};

/**
 * How a related scored entity's row (by its id) links to this row, for the
 * manifest's `related` roll-up: `relatedGaps`, `relatedExceptions`, and the
 * `dataGap` filter accepting the related entity's check ids.
 */
export type RelatedQualityLinks<T extends ScoredTable> = {
  readonly [R in ScoredEntity]?: {
    // Bivariant on purpose (the React-props trick): a mapped type cannot
    // carry a method signature, and a plain property would make the
    // per-table entries unassignable to the erased registry type.
    bivarianceHack(t: T, relatedId: SQL): SQL;
  }["bivarianceHack"];
};
