import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { getTableColumns } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import {
  INCOMING_EDGES,
  type IncomingEdge,
} from "~/server/db/entity-incoming-edges";
import { databaseForTransaction, getDb } from "~/server/repo/database-helpers";
import { countByTarget } from "~/server/repo/impact";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

/** Effects that leave a successful delete with no changed incoming rows. */
const UNCHANGED_ON_SUCCESS = new Set<OperationDisposition["effect"]>([
  "block",
  "preserve",
]);

export type AffectedDeleteEdge = {
  edge: string;
  effect: OperationDisposition["effect"];
  changed: number;
};

/** Convert the before/after snapshots into the public, exact delete report. */
export const calculateAffectedDeleteEdges = (
  policy: Record<string, OperationDisposition>,
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): AffectedDeleteEdge[] =>
  Object.entries(policy).map(([edge, disposition]) => ({
    edge,
    effect: disposition.effect,
    changed: UNCHANGED_ON_SUCCESS.has(disposition.effect)
      ? 0
      : Math.max(0, (before.get(edge) ?? 0) - (after.get(edge) ?? 0)),
  }));

/**
 * Run a delete with its incoming-edge accounting in one repeatable-read
 * repository transaction. The repository owns both the Drizzle transaction
 * adapter and the before/delete/after sequence.
 */
export async function executeDeleteWithEffects<
  E extends ShortcodeEntity,
  TResult,
>(
  db: Database,
  entity: E,
  shortcodes: readonly string[],
  policy: Record<string, OperationDisposition>,
  execute: (transactionDb: Database) => Promise<TResult>,
): Promise<{
  result: TResult;
  affectedEdges: AffectedDeleteEdge[];
}> {
  const entries = Object.entries(policy);
  const snapshot = async (transactionDb: Database, ids: readonly string[]) =>
    new Map(
      await Promise.all(
        entries.flatMap(([edge, disposition]) => {
          if (UNCHANGED_ON_SUCCESS.has(disposition.effect)) return [];
          // SAFETY: policy keys are exhaustively checked against this entity's
          // INCOMING_EDGES entry by entity-edge-operation-policies.unit.test.
          const incoming = INCOMING_EDGES[entity][
            edge as keyof (typeof INCOMING_EDGES)[E]
          ] as IncomingEdge;
          // SAFETY: INCOMING_EDGES is built only from Postgres schema columns.
          const table = incoming.column.table as PgTable;
          // SAFETY: INCOMING_EDGES is built only from Postgres schema columns.
          const column = incoming.column as PgColumn;
          const includeDeleted = !("deletedAt" in getTableColumns(table));
          return [
            countByTarget(getDb(transactionDb), table, column, ids, {
              includeDeleted,
            }).then(
              (counts) =>
                [
                  edge,
                  Object.values(counts).reduce(
                    (total, edgeCount) => total + edgeCount,
                    0,
                  ),
                ] as const,
            ),
          ];
        }),
      ),
    );

  return getDb(db).transaction(
    async (tx) => {
      const transactionDb = databaseForTransaction(tx);
      const ids = await resolveAllOrThrow(transactionDb, entity, shortcodes);
      const before = await snapshot(transactionDb, ids);
      const result = await execute(transactionDb);
      const after = await snapshot(transactionDb, ids);
      return {
        result,
        affectedEdges: calculateAffectedDeleteEdges(policy, before, after),
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
