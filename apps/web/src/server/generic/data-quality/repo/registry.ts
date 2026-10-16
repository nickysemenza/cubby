import type { DataCheckOf, ScoredEntity } from "@cubby/schemas/data-quality";
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

/**
 * One check's SQL, written once against `t` — the entity's own table or an
 * `alias()` of it, so a Purchase can evaluate a linked Product's check under
 * `"dq_r"` with the same binding the Product list uses. Method signatures
 * (not arrow properties) keep the registry assignable across table types.
 */
/** The declared derived relation joined by a bounded hydration read. */
export interface QualityReadContext {
  readonly derivedAlias: string;
}

export interface CheckBinding<T extends ScoredTable> {
  /** Whether the check applies to this row at all; omitted = always. */
  expected?(t: T, context?: QualityReadContext): SQL;
  /** Evaluated only under `expected`. */
  missing(t: T, context?: QualityReadContext): SQL;
  /**
   * The inputs this check reads, so a stored exception stays active until
   * that evidence changes. Required exactly when the entity has exceptions.
   */
  fingerprint?(t: T, context?: QualityReadContext): readonly SQL[];
}

export interface EntityChecks<E extends ScoredEntity, T extends ScoredTable> {
  entity: E;
  table: T;
  /** One row per entityId; all checks share it for the selected ID batch. */
  derivedRead?(ids: SQL): SQL;
  /** One row per entityId for bulk filters and score sorting, before paging. */
  filterRead?(): SQL;
  /** Exhaustive against the generated per-entity check union. */
  checks: { readonly [C in DataCheckOf<E>]: CheckBinding<T> };
  /**
   * How a related scored entity's row (by its id) links to this row, for the
   * manifest's `related` roll-up: `relatedGaps`, `relatedExceptions`, and the
   * `dataGap` filter accepting the related entity's check ids.
   */
  related?: {
    readonly [R in ScoredEntity]?: {
      // Bivariant on purpose (the React-props trick): a mapped type cannot
      // carry a method signature, and a plain property would make the
      // per-table entries unassignable to the erased registry type.
      bivarianceHack(t: T, relatedId: SQL): SQL;
    }["bivarianceHack"];
  };
}

/** Identity helper so each `checks/<entity>.ts` infers its own table type. */
export const defineEntityChecks = <
  E extends ScoredEntity,
  T extends ScoredTable,
>(
  entry: EntityChecks<E, T>,
): EntityChecks<E, T> => entry;
