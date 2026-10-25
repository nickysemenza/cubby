/**
 * The compute seam for stored derived values. An adapter receives a batch of
 * record ids and returns each live record's value; an id absent from the
 * result has no value (deleted, or not applicable) and its stored row is
 * removed. Adapters read authoritative inputs only, never another stored
 * derived value unless the declaration lists it in `dependsOn`.
 */
import type { Database, DrizzleTransaction } from "~/server/db";

export interface DerivedComputed {
  /** The published value; JSON. */
  readonly value: unknown;
  /** The typed projection lists sort and filter on. */
  readonly sort: number | string | null;
  /** Which level decided the value, for values with a decision chain. */
  readonly decidedBy?: unknown;
  /** Paid work only: the hash of the declared input projection. */
  readonly inputHash?: string | null;
}

export type DerivedCompute = (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) => Promise<ReadonlyMap<string, DerivedComputed>>;

export type DerivedComputes = Readonly<Record<string, DerivedCompute>>;
