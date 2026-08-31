import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { getTableColumns } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { Database, type DrizzleTransaction } from "~/server/db";
import type { DatabaseClient } from "~/server/db/database";
import {
  INCOMING_EDGES,
  type IncomingEdge,
} from "~/server/db/entity-incoming-edges";
import { getDb } from "~/server/repo/database-helpers";
import { countByTarget } from "~/server/repo/impact";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

/** Effects that leave a successful delete with no changed incoming rows. */
const UNCHANGED_ON_SUCCESS = new Set<OperationDisposition["effect"]>([
  "block",
  "preserve",
]);

/**
 * Measure the concrete incoming rows a successful delete changed.
 *
 * Delete repositories run their own locking and mutation transaction; this
 * report uses the same live-row predicate as those mutations. A `block` edge
 * can only reach a successful result at zero, while a `preserve` edge is
 * intentionally left untouched. Every other effect changes the live rows that
 * point at the deleted targets.
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
  affectedEdges: Array<{
    edge: string;
    effect: OperationDisposition["effect"];
    changed: number;
  }>;
}> {
  const transactionDatabase = (tx: DrizzleTransaction) => {
    // SAFETY: the repository-only Database facade exposes the same schema-bound
    // Drizzle methods as DatabaseClient; nested transactions become savepoints.
    const client = tx as DatabaseClient;
    return new Database(() => ({
      client,
      withConnection: (fn) => fn(client),
    }));
  };
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
      const transactionDb = transactionDatabase(tx);
      const ids = await resolveAllOrThrow(transactionDb, entity, shortcodes);
      const before = await snapshot(transactionDb, ids);
      const result = await execute(transactionDb);
      const after = await snapshot(transactionDb, ids);
      return {
        result,
        affectedEdges: entries.map(([edge, disposition]) => ({
          edge,
          effect: disposition.effect,
          changed: UNCHANGED_ON_SUCCESS.has(disposition.effect)
            ? 0
            : Math.max(0, (before.get(edge) ?? 0) - (after.get(edge) ?? 0)),
        })),
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
