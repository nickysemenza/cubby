import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";

/** One transaction for a Run's work step; services compose repo writes inside it. */
export async function withRunTransaction<T>(
  db: Database,
  operation: (transactionDb: Database) => Promise<T>,
): Promise<T> {
  return withTransactionDatabase(db, operation);
}
