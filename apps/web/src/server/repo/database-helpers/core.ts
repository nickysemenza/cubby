/**
 * Core database access functions.
 * Unwrap opaque Database type and handle transactions.
 */

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { TraceNames, withTrace } from "~/server/tracing";

/**
 * Get the underlying Drizzle client from the opaque Database type.
 * This should ONLY be used within repo files to access the database.
 * Services and routers should never call this - they just pass Database around.
 */
export const getDb = (db: Database): DrizzleClient => {
  return db as unknown as DrizzleClient;
};

/**
 * Safely unwrap Database or use DrizzleTransaction directly.
 * Detects if the input is already a DrizzleTransaction and returns it,
 * otherwise unwraps the branded Database type.
 */
export const unwrapDb = (
  db: Database | DrizzleTransaction,
): DrizzleClient | DrizzleTransaction => {
  // Check if it's a transaction by looking for transaction-specific methods
  return "rollback" in db ? db : getDb(db);
};

/**
 * Transaction wrapper for interactive transactions (sequential operations).
 * Use this in repo functions when you need multiple operations to be atomic.
 */
export const withTransaction = async <T>(
  db: Database,
  fn: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> => {
  return withTrace(TraceNames.db("transaction"), async () => {
    return await getDb(db).transaction(fn);
  });
};
