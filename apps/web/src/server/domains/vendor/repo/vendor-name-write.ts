import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
} from "~/server/db/helpers/core";
import { vendor } from "~/server/db/schema";

const vendorDatabase = (db: Database | DrizzleTransaction) =>
  isTransaction(db) ? databaseForTransaction(db) : db;

/**
 * Take the household write gate before writing a Vendor's names. Reconcilers
 * read Vendors by name and alias, so the write reports its keys; the gate must
 * be the transaction's first lock, and entering refuses a transaction that
 * already holds another one.
 */
export async function enterVendorNameWrite(db: Database | DrizzleTransaction) {
  const { enterHouseholdGate } = await import("~/server/kernel/api");
  await enterHouseholdGate(vendorDatabase(db));
}

/** Report a Vendor whose names a writer set, with its row before the write. */
export async function reportVendorNameWrite(
  db: Database | DrizzleTransaction,
  id: string,
  columns: readonly string[],
  before?: typeof vendor.$inferSelect,
) {
  const { emitWrites } = await import("~/server/kernel/api");
  await emitWrites(vendorDatabase(db), {
    table: vendor,
    ids: [id],
    columns,
    before: before ? [before] : [],
  });
}
