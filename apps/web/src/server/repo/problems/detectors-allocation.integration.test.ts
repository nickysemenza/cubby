import type {
  FinancialTransactionId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { financialTransactionAllocation } from "~/server/db/schema";
import { getDb, insertAndReturn } from "~/server/repo/database-helpers";
import { listFinancialTransactions } from "~/server/repo/financial-transaction";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  findFinancialTransactionAllocationDefects,
  loadAllocationDefectPresenters,
} from "./detectors-financial";

/**
 * Backstop coverage for `findFinancialTransactionAllocationDefects`.
 *
 * Fixtures insert allocations directly rather than through
 * `setFinancialTransactionAllocations`, for the same reason
 * detectors-integrity.integration.test.ts bypasses the repo layer: the write
 * path is precisely what this detector exists to backstop, so manufacturing a
 * violation requires reaching around the protection that would refuse it.
 *
 * The two sign cases are the ones worth reading closely. A transaction split
 * across several purchases has a NULL mirror `purchaseId`, so
 * `FinancialTransaction_purchase_settlement_check` — scoped to linked rows —
 * passes it vacuously. These rows are the only enforcement left there, and will
 * be the only enforcement anywhere once the mirror column is dropped.
 */

let seq = 0;
const uniq = (label: string) => `${label}-${(seq++).toString(36)}`;

const mkPurchase = async (db: Database) => {
  const vendor = await insertWithShortcode(db, "vendor", {
    name: uniq("Vendor"),
  });
  return insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    date: "2026-08-10",
  });
};

const mkTransaction = async (
  db: Database,
  overrides: {
    kind?: string;
    amount?: number;
    purchaseId?: PurchaseId | null;
  } = {},
) => {
  const account = await insertWithShortcode(db, "financialAccount", {
    name: uniq("Account"),
    identity: { kind: "cash" },
  });
  const values = {
    accountId: account.id,
    kind: overrides.kind ?? "refund",
    status: "posted" as const,
    postedDate: "2026-08-10",
    amount: overrides.amount ?? -16.76,
  };
  // Only a transaction that actually settles a purchase gets an allocation;
  // the rest are unlinked evidence and take the plain insert.
  return overrides.purchaseId
    ? insertSettlementTransaction(db, {
        ...values,
        purchaseId: overrides.purchaseId,
      })
    : insertWithShortcode(db, "financialTransaction", values);
};

const allocate = (
  db: Database,
  transactionId: FinancialTransactionId,
  purchaseId: PurchaseId,
  amount: number,
) =>
  insertAndReturn(db, financialTransactionAllocation, {
    transactionId,
    purchaseId,
    amount,
  });

const liveDefects = async (db: Database) =>
  listFinancialTransactions(db, { allocationIntegrity: "defect" }, [], {
    pageIndex: 0,
    pageSize: 100,
  });

describe("findFinancialTransactionAllocationDefects", () => {
  const ctx = withTestDb();

  it("passes a split that sums to the transaction amount with a NULL mirror", async () => {
    const [a, b] = await Promise.all([mkPurchase(ctx.db), mkPurchase(ctx.db)]);
    const txn = await mkTransaction(ctx.db, { amount: -16.76 });
    await allocate(ctx.db, txn.id, a.id, -8.96);
    await allocate(ctx.db, txn.id, b.id, -7.8);

    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);
    expect((await liveDefects(ctx.db)).data).toEqual([]);
    expect(
      (await loadAllocationDefectPresenters(ctx.db, [txn.shortcode])).get(
        txn.shortcode,
      )?.reasons,
    ).toEqual([]);
  });

  it("flags allocations that do not sum to the transaction amount", async () => {
    const [a, b] = await Promise.all([mkPurchase(ctx.db), mkPurchase(ctx.db)]);
    const txn = await mkTransaction(ctx.db, { amount: -16.76 });
    await allocate(ctx.db, txn.id, a.id, -8.96);
    await allocate(ctx.db, txn.id, b.id, -7.0); // 4 cents short

    const [defect, ...rest] = await findFinancialTransactionAllocationDefects(
      ctx.db,
    );
    expect(rest).toEqual([]);
    expect(defect?.reasons).toContain("sum-mismatch");
    expect(defect?.allocationCount).toBe(2);
    expect(defect?.allocatedTotal).toBeCloseTo(-15.96, 2);
    expect(defect?.purchaseIds).toHaveLength(2);
    const live = await liveDefects(ctx.db);
    expect(live.data.map((row) => row.id)).toEqual([txn.shortcode]);
    expect(
      (await loadAllocationDefectPresenters(ctx.db, [txn.shortcode])).get(
        txn.shortcode,
      )?.reasons,
    ).toContain("sum-mismatch");
  });

  it("flags a non-settlement kind carrying allocations", async () => {
    const purchase = await mkPurchase(ctx.db);
    const txn = await mkTransaction(ctx.db, { kind: "fee", amount: 12 });
    await allocate(ctx.db, txn.id, purchase.id, 12);

    const [defect] = await findFinancialTransactionAllocationDefects(ctx.db);
    expect(defect?.reasons).toContain("non-settlement-kind");
    expect((await liveDefects(ctx.db)).data.map((row) => row.id)).toEqual([
      txn.shortcode,
    ]);
  });

  it("flags a kind/sign violation the DB CHECK passes vacuously on a split row", async () => {
    // A refund must be negative. With a NULL mirror the row-level CHECK does not
    // bind at all, so this INSERT succeeds and only the detector objects — which
    // is the whole reason the detector carries this reason.
    const [a, b] = await Promise.all([mkPurchase(ctx.db), mkPurchase(ctx.db)]);
    const txn = await mkTransaction(ctx.db, { kind: "refund", amount: 20 });
    await allocate(ctx.db, txn.id, a.id, 12);
    await allocate(ctx.db, txn.id, b.id, 8);

    const [defect] = await findFinancialTransactionAllocationDefects(ctx.db);
    expect(defect?.reasons).toContain("kind-sign-violation");
    expect(defect?.reasons).not.toContain("sum-mismatch");
    expect((await liveDefects(ctx.db)).data.map((row) => row.id)).toEqual([
      txn.shortcode,
    ]);
  });

  it("ignores soft-deleted allocations", async () => {
    const purchase = await mkPurchase(ctx.db);
    const txn = await mkTransaction(ctx.db, { amount: -5 });
    const dead = await allocate(ctx.db, txn.id, purchase.id, -99);
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialTransactionAllocation" SET "deletedAt" = now() WHERE id = ${dead.id}`,
    );

    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);
    expect((await liveDefects(ctx.db)).data).toEqual([]);
  });
});
