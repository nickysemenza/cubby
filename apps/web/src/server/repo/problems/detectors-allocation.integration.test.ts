import type {
  FinancialTransactionId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { financialTransactionAllocation } from "~/server/db/schema";
import { getDb, insertAndReturn } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findFinancialTransactionAllocationDefects } from "./detectors-financial";

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
  return insertWithShortcode(db, "financialTransaction", {
    accountId: account.id,
    kind: overrides.kind ?? "refund",
    status: "posted",
    postedDate: "2026-08-10",
    amount: overrides.amount ?? -16.76,
    purchaseId: overrides.purchaseId ?? null,
  });
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

describe("findFinancialTransactionAllocationDefects", () => {
  const ctx = withTestDb();

  it("passes a split that sums to the transaction amount with a NULL mirror", async () => {
    // The real 2026-08-10 Home Depot case: one -$16.76 card credit settling two
    // different orders. This is the shape the table exists to make legal.
    const [a, b] = await Promise.all([mkPurchase(ctx.db), mkPurchase(ctx.db)]);
    const txn = await mkTransaction(ctx.db, { amount: -16.76 });
    await allocate(ctx.db, txn.id, a.id, -8.96);
    await allocate(ctx.db, txn.id, b.id, -7.8);

    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);
  });

  it("passes a single allocation whose mirror agrees, and an unallocated transaction", async () => {
    const purchase = await mkPurchase(ctx.db);
    const linked = await mkTransaction(ctx.db, {
      amount: -32.55,
      purchaseId: purchase.id,
    });
    await allocate(ctx.db, linked.id, purchase.id, -32.55);
    await mkTransaction(ctx.db, { amount: -5 }); // unlinked evidence, no allocations

    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);
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
  });

  it("flags a mirror still set while the transaction is split across two purchases", async () => {
    const [a, b] = await Promise.all([mkPurchase(ctx.db), mkPurchase(ctx.db)]);
    const txn = await mkTransaction(ctx.db, {
      amount: -16.76,
      purchaseId: a.id, // stale: a split transaction's mirror must be NULL
    });
    await allocate(ctx.db, txn.id, a.id, -8.96);
    await allocate(ctx.db, txn.id, b.id, -7.8);

    const [defect] = await findFinancialTransactionAllocationDefects(ctx.db);
    expect(defect?.reasons).toEqual(["mirror-drift"]);
  });

  it("flags a mirror pointing at a purchase the allocations do not name", async () => {
    const [a, b] = await Promise.all([mkPurchase(ctx.db), mkPurchase(ctx.db)]);
    const txn = await mkTransaction(ctx.db, {
      amount: -32.55,
      purchaseId: b.id,
    });
    await allocate(ctx.db, txn.id, a.id, -32.55);

    const [defect] = await findFinancialTransactionAllocationDefects(ctx.db);
    expect(defect?.reasons).toEqual(["mirror-drift"]);
  });

  it("flags a non-settlement kind carrying allocations", async () => {
    const purchase = await mkPurchase(ctx.db);
    const txn = await mkTransaction(ctx.db, { kind: "fee", amount: 12 });
    await allocate(ctx.db, txn.id, purchase.id, 12);

    const [defect] = await findFinancialTransactionAllocationDefects(ctx.db);
    expect(defect?.reasons).toContain("non-settlement-kind");
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
  });

  it("flags an allocation whose sign differs from its transaction", async () => {
    const [a, b] = await Promise.all([mkPurchase(ctx.db), mkPurchase(ctx.db)]);
    const txn = await mkTransaction(ctx.db, { amount: -10 });
    // Sums correctly, so only the sign rule catches it.
    await allocate(ctx.db, txn.id, a.id, -15);
    await allocate(ctx.db, txn.id, b.id, 5);

    const [defect] = await findFinancialTransactionAllocationDefects(ctx.db);
    expect(defect?.reasons).toContain("allocation-sign-mismatch");
    expect(defect?.reasons).not.toContain("sum-mismatch");
  });

  it("ignores soft-deleted allocations", async () => {
    const purchase = await mkPurchase(ctx.db);
    const txn = await mkTransaction(ctx.db, { amount: -5 });
    const dead = await allocate(ctx.db, txn.id, purchase.id, -99);
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialTransactionAllocation" SET "deletedAt" = now() WHERE id = ${dead.id}`,
    );

    expect(await findFinancialTransactionAllocationDefects(ctx.db)).toEqual([]);
  });
});
