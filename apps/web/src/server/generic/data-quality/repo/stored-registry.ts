import type {
  DataCheck,
  DataCheckOf,
  ScoredEntity,
} from "@cubby/schemas/data-quality";
import type { EntityQualityCheckState } from "@cubby/schemas/data-quality-shape";

import type { Database, DrizzleTransaction } from "~/server/db";
import type {
  EntityChecks,
  ScoredTable,
} from "~/server/generic/data-quality/repo/registry";

import type { QualityCheck } from "./builders";

type QualityRecord = { id: string; shortcode: string };
export type QualityEvaluation = QualityRecord & {
  checks: Readonly<Partial<Record<DataCheck, EntityQualityCheckState>>>;
};

/** The per-entity switch: SQL bindings or a versioned batch-loaded TS evaluator. */
export interface StoredEntityChecks<
  E extends ScoredEntity,
  T extends ScoredTable,
> {
  storage: "stored";
  entity: E;
  table: T;
  rulesVersion: number;
  evaluate(
    db: Database | DrizzleTransaction,
    ids: readonly string[],
  ): Promise<QualityEvaluation[]>;
  related?: EntityChecks<E, T>["related"];
}

/** A loader owns all source reads for its ID page; functions only inspect its records. */
export function defineStoredEntityChecks<
  E extends ScoredEntity,
  T extends ScoredTable,
  R extends QualityRecord,
>(entry: {
  entity: E;
  table: T;
  rulesVersion: number;
  load(db: Database | DrizzleTransaction, ids: readonly string[]): Promise<R[]>;
  checks: { readonly [C in DataCheckOf<E>]: QualityCheck<R> };
  related?: EntityChecks<E, T>["related"];
}): StoredEntityChecks<E, T> {
  return {
    storage: "stored",
    entity: entry.entity,
    table: entry.table,
    rulesVersion: entry.rulesVersion,
    related: entry.related,
    evaluate: async (db, ids) =>
      (await entry.load(db, ids)).map((record) => ({
        id: record.id,
        shortcode: record.shortcode,
        checks: Object.fromEntries(
          Object.entries<QualityCheck<R>>(entry.checks).map(([key, check]) => [
            key,
            check(record),
          ]),
        ),
      })),
  };
}
