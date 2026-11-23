import type { Database, DrizzleTransaction } from "~/server/db";
import { databaseForTransaction } from "~/server/db/helpers/core";
import { email as emailTable } from "~/server/db/retained-tables";

/**
 * Email state reads its Email's Run through the row's `runId`, so assigning,
 * transferring or releasing an Email raises its row key; a status-only write
 * reports `status`, which raises a key only for a reconciler that declares
 * it. The caller holds the household write gate, taken before its first row
 * lock.
 */
export async function emitEmailRunAssignment(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
  columns: readonly ("runId" | "status")[] = ["runId", "status"],
): Promise<void> {
  if (!ids.length) return;
  const { emitWrites } = await import("~/server/kernel/api");
  await emitWrites("rollback" in db ? databaseForTransaction(db) : db, {
    table: emailTable,
    ids,
    columns,
  });
}
