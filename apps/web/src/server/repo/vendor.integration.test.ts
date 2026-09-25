import type {
  PurchaseId,
  VendorId,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  auditLog,
  entityAttachment,
  expense,
  purchase,
  vendor,
} from "~/server/db/schema";

import { getDb, insertAndReturn, notDeleted } from "./database-helpers";
import { createExpense } from "./expense";
import {
  createPurchase,
  deletePurchases,
  findOrCreatePurchase,
  getPurchaseByID,
  getPurchaseExpenses,
} from "./purchase";
import { makeExpenseInput } from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { insertWithShortcode } from "./shortcode-utils";
import {
  deleteVendors,
  findOrCreateVendor,
  getVendorByID,
  getVendorCoverage,
  mergeVendors,
  vendorList,
  updateVendor,
} from "./vendor";

/**
 * `Vendor` is a thin roster: `name` (partial-unique where live), `website`,
 * `notes`. No money is stored here — `vendorOut.spend` is a
 * correlated rollup over the vendor's live charges' live expenses, and the tests
 * below pin that it can never come from `purchase.statedTotal`.
 */

const page = { pageIndex: 0, pageSize: 50 };

describe("vendor repository — findOrCreateVendor", () => {
  const ctx = withTestDb();

  it("two concurrent calls for one new name produce exactly one vendor", async () => {
    // The reason `findOrCreateVendor` goes through `findOrCreate`
    // (`ON CONFLICT DO NOTHING` + re-select) rather than findFirst + insert:
    // two concurrent imports naming the same new vendor must yield one row, not
    // a 500 on `Vendor_name_key`.
    const [a, b] = await Promise.all([
      findOrCreateVendor(ctx.db, "Flow Form Plumbing"),
      findOrCreateVendor(ctx.db, "Flow Form Plumbing"),
    ]);

    expect(a).toBe(b);
    const rows = await getDb(ctx.db)
      .select({ id: vendor.id })
      .from(vendor)
      .where(eq(vendor.name, "Flow Form Plumbing"));
    expect(rows).toHaveLength(1);
  });
});

describe("vendor declared scalar updates", () => {
  const ctx = withTestDb();

  it("preserves omitted fields and audits only actual changes", async () => {
    const id = await findOrCreateVendor(ctx.db, "Scalar patch vendor");
    const original = await getVendorByID(ctx.db, id);
    await updateVendor(
      ctx.db,
      original.id,
      { notes: "Keep this note", website: "https://example.com" },
      ctx.actor,
    );
    const changed = await updateVendor(
      ctx.db,
      original.id,
      { name: "Renamed scalar vendor" },
      ctx.actor,
    );
    expect(changed.output).toMatchObject({
      name: "Renamed scalar vendor",
      notes: "Keep this note",
      website: "https://example.com",
    });
    const beforeNoop = await getDb(ctx.db)
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "vendor"),
          eq(auditLog.entityId, id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(beforeNoop).toHaveLength(2);
    await updateVendor(
      ctx.db,
      original.id,
      { name: "Renamed scalar vendor" },
      ctx.actor,
    );
    await updateVendor(ctx.db, original.id, {}, ctx.actor);
    const afterNoop = await getDb(ctx.db)
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "vendor"),
          eq(auditLog.entityId, id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(afterNoop).toHaveLength(2);
    expect((await getVendorByID(ctx.db, id)).updatedAt).toEqual(
      changed.output.updatedAt,
    );
  });
});

describe("vendor repository — spend rollup", () => {
  const ctx = withTestDb();

  it("spend is SUM(expense.cost), never the charge's statedTotal", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Spend Rollup Vendor");
    const vendorShortcode = (await getVendorByID(ctx.db, vendorId)).id;
    const { output: charge } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2024-01-15",
        vendorId: vendorShortcode,
        orderId: "SPEND-1",
        // Wildly wrong on purpose. `statedTotal` is only a reconciliation cue;
        // if it ever reached `spend` this assertion would read 99999.
        statedTotal: 99999,
      }),
      ctx.actor,
    );

    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        name: "spend line",
        trade: "other",
        costType: "materials",
        cost: 100,
        purchaseId: charge.id,
      }),
      ctx.actor,
    );
    // A negative line (a refund) is real spend and must net in — never filtered
    // out, or the vendor's total stops reconciling.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        name: "spend refund",
        trade: "other",
        costType: "materials",
        cost: -25,
        purchaseId: charge.id,
      }),
      ctx.actor,
    );

    const row = await getVendorByID(ctx.db, vendorId);
    expect(row.spend).toBe(75);
    expect(row.spend).not.toBe(charge.statedTotal);
    expect(row.purchaseCount).toBe(1);
  });
});

describe("vendor coverage", () => {
  const ctx = withTestDb();

  it("uses inclusive boundaries, unique sorted order ids, and latest overall", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Coverage Vendor");
    const vendorRow = await getVendorByID(ctx.db, vendorId);
    for (const [date, orderId] of [
      ["2026-09-01", "OUTSIDE-EARLY"],
      ["2026-09-10", "ORDER-B"],
      ["2026-09-20", "ORDER-A"],
      ["2026-09-30", null],
      ["2026-10-01", "OUTSIDE-LATEST"],
    ] as const) {
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ date, vendorId: vendorRow.id, orderId }),
        ctx.actor,
      );
    }

    await expect(
      getVendorCoverage(ctx.db, {
        vendorId: vendorRow.id,
        from: "2026-09-10",
        to: "2026-09-30",
      }),
    ).resolves.toEqual({
      vendor: { id: vendorRow.id, name: "Coverage Vendor" },
      latestPurchaseDate: "2026-10-01",
      from: "2026-09-10",
      to: "2026-09-30",
      orderIds: ["ORDER-A", "ORDER-B"],
    });
  });
});

describe("vendor repository — deletion guard", () => {
  const ctx = withTestDb();

  it("refuses to delete a vendor with live charges, and succeeds once they are gone", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Load Bearing Vendor");
    const charge = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: "LB-1",
      date: "2024-01-15",
    });
    const vendorShortcode = (await getVendorByID(ctx.db, vendorId)).id;

    // Dropping the vendor would leave that charge resolving `vendorName` to
    // null, which reads as "no vendor recorded" and is a lie. The re-point path
    // is `mergePurchases`, not a cascade.
    await expect(
      deleteVendors(ctx.db, [vendorShortcode], ctx.actor),
    ).rejects.toMatchObject({
      reason: "ENTITY_DELETE_BLOCKED",
    });

    await deletePurchases(
      ctx.db,
      [(await getPurchaseByID(ctx.db, charge)).id],
      ctx.actor,
    );
    await deleteVendors(ctx.db, [vendorShortcode], ctx.actor);

    await expect(getVendorByID(ctx.db, vendorId)).rejects.toMatchObject({
      reason: "VENDOR_NOT_FOUND",
    });
    expect((await vendorList(ctx.db, {}, [], page)).count).toBe(0);
  });
});

/**
 * `mergeVendors` — the roster's dedupe path (`B&H` / `B&H Photo`).
 *
 * The load-bearing part is the partial-unique `(vendorId, orderId) WHERE orderId
 * IS NOT NULL AND live` index on `Purchase`: re-pointing every loser's charges at
 * the keeper collides whenever two merged vendors hold a charge with the SAME
 * non-null order id — the signature of the duplication being fixed (one order
 * imported twice under two spellings). Those two charges are one charge, so they
 * fold instead of throwing.
 *
 * Every test here also pins the money invariant: a merge moves spend between
 * charges and never creates or destroys any.
 */
describe("vendor repository — mergeVendors", () => {
  const ctx = withTestDb();

  /** `SUM(cost)` over EVERY live expense in the database, charge or no charge. */
  const liveExpenseTotal = async (): Promise<number> => {
    const [row] = await getDb(ctx.db)
      .select({
        total: sql<number>`COALESCE(sum(${expense.cost}), 0)::double precision`,
      })
      .from(expense)
      .where(notDeleted(expense));
    return Number(row?.total ?? 0);
  };

  const chargeRow = async (id: PurchaseId) => {
    const [row] = await getDb(ctx.db)
      .select({
        vendorId: purchase.vendorId,
        orderId: purchase.orderId,
        statedTotal: purchase.statedTotal,
        deletedAt: purchase.deletedAt,
      })
      .from(purchase)
      .where(eq(purchase.id, id))
      .limit(1);
    return row;
  };

  const auditRows = async (
    entityType: "vendor" | "purchase" | "expense",
    entityId: string,
    action: "create" | "update" | "delete",
  ) =>
    getDb(ctx.db)
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, entityType),
          eq(auditLog.entityId, entityId),
          eq(auditLog.action, action),
        ),
      );

  // The audit log's `entityId` is always the row's internal uuid (every writer
  // in vendor.ts/purchase.ts logs `entityId: <uuid column>`), but `createVendor`
  // and `createExpense` only ever hand back the public shortcode. These two
  // resolve back to the uuid the audit rows above actually key on.

  // The inverse direction: `findOrCreateVendor` (the import hot path) still
  // returns the internal uuid, but `mergeVendors`'s input and `VendorOut.id`
  // are shortcodes post-cutover.
  const vendorCode = async (id: VendorId): Promise<VendorShortcode> =>
    (await getVendorByID(ctx.db, id)).id;

  const addLine = async (name: string, cost: number, purchaseId: PurchaseId) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name,
          cost,
          purchaseId: (await getPurchaseByID(ctx.db, purchaseId)).id,
        }),
      ),
      ctx.actor,
    );

  const attachDocumentRow = async (purchaseId: PurchaseId, label: string) => {
    const img = await insertWithShortcode(ctx.db, "image", {
      key: `test-documents/${label}.pdf`,
      filename: `${label}.pdf`,
      contentType: "application/pdf",
      size: 100,
      status: "UPLOADED",
    });
    const join = await insertAndReturn(ctx.db, entityAttachment, {
      subjectEntityId: purchaseId,
      imageId: img.id,
    });
    return { imageId: img.id, joinId: join.id };
  };

  // Returns the charge's internal uuid — every downstream helper here
  // (`chargeRow`, `getPurchaseExpenses`, `getPurchaseByID`, the audit-row
  // lookups) is keyed on it, even though `createPurchase` itself now speaks
  // shortcodes at its public boundary.
  const charge = async (
    vendorId: VendorId,
    orderId: string | null,
    statedTotal: number | null = null,
  ): Promise<PurchaseId> => {
    const { output: created } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2024-01-15",
        vendorId: await vendorCode(vendorId),
        orderId,
        statedTotal,
      }),
      ctx.actor,
    );
    const id = await resolveLiveShortcode(ctx.db, created.id, "purchase");
    if (!id) throw new Error(`purchase not found: ${created.id}`);
    return parseEntityId("purchase", id);
  };

  it("re-points the losers' charges, soft-deletes the losers, and unions the keeper's rollups", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "B&H Photo");
    const loser = await findOrCreateVendor(ctx.db, "B&H");

    const keeperCharge = await charge(keeper, "KEEP-1");
    const loserOrdered = await charge(loser, "LOSE-1");
    const loserCashRun = await charge(loser, null);

    await addLine("keeper line", 100, keeperCharge);
    await addLine("loser line", 40, loserOrdered);
    await addLine("cash run line", 10, loserCashRun);

    const moneyBefore = await liveExpenseTotal();
    // Captured BEFORE the merge: `vendorCode` reads through `getVendorByID`,
    // which 404s on the loser the instant it's soft-deleted below.
    const keeperCode = await vendorCode(keeper);
    const loserCode = await vendorCode(loser);

    const { vendor: merged, mergeSummary } = await mergeVendors(
      ctx.db,
      { keepId: keeperCode, mergeIds: [loserCode] },
      ctx.actor,
    );

    expect(merged.id).toBe(keeperCode);
    // Union of both sides: 3 live charges, 150 of live spend.
    expect(merged.purchaseCount).toBe(3);
    expect(merged.spend).toBe(150);

    expect(mergeSummary).toEqual({
      keepId: keeperCode,
      deletedIds: [loserCode],
      // Measured by `finalizeMerge`, not `mergeIds.length`.
      merged: 1,
      purchasesRepointed: 2,
      purchasesFolded: 0,
      carriedFields: [],
    });

    for (const id of [keeperCharge, loserOrdered, loserCashRun]) {
      const row = await chargeRow(id);
      expect(row?.vendorId).toBe(keeper);
      expect(row?.deletedAt).toBeNull();
    }

    // Nothing was folded here, so every expense keeps its own charge and cost.
    expect(
      (await getPurchaseExpenses(ctx.db, loserOrdered)).map((l) => l.cost),
    ).toEqual([40]);

    await expect(getVendorByID(ctx.db, loser)).rejects.toMatchObject({
      reason: "VENDOR_NOT_FOUND",
    });

    // A merge relocates spend; it must never mint or destroy any.
    expect(await liveExpenseTotal()).toBe(moneyBefore);
  });

  it("folds two charges sharing an order id rather than violating the partial-unique index", async () => {
    // The signature case: one Amazon order imported under two spellings. Both
    // charges carry the same non-null order id, so they CANNOT both survive
    // under one vendor — re-pointing blind would raise a unique violation.
    const keeper = await findOrCreateVendor(ctx.db, "Amazon");
    const loser = await findOrCreateVendor(ctx.db, "Amazon.com");

    const survivor = await charge(keeper, "111-AMZ-1");
    const dead = await charge(loser, "111-AMZ-1");

    await addLine("survivor line", 30, survivor);
    await addLine("folded line", 70, dead);
    const survivorDoc = await attachDocumentRow(survivor, "survivor-invoice");
    const deadDoc = await attachDocumentRow(dead, "folded-invoice");

    const moneyBefore = await liveExpenseTotal();
    // Captured BEFORE the merge — see the earlier test's note on why.
    const keeperCode = await vendorCode(keeper);
    const loserCode = await vendorCode(loser);

    const { vendor: merged, mergeSummary } = await mergeVendors(
      ctx.db,
      { keepId: keeperCode, mergeIds: [loserCode] },
      ctx.actor,
    );

    expect(merged.purchaseCount).toBe(1);
    expect(merged.spend).toBe(100);

    expect(mergeSummary).toEqual({
      keepId: keeperCode,
      deletedIds: [loserCode],
      merged: 1,
      purchasesRepointed: 0,
      purchasesFolded: 1,
      carriedFields: [],
    });

    const lines = await getPurchaseExpenses(ctx.db, survivor);
    expect(lines.map((l) => l.name).sort()).toEqual([
      "folded line",
      "survivor line",
    ]);

    const survivorDocs = await getDb(ctx.db).query.entityAttachment.findMany({
      where: and(
        eq(entityAttachment.subjectEntityId, survivor),
        notDeleted(entityAttachment),
      ),
    });
    expect(survivorDocs.map((d) => d.imageId).sort()).toEqual(
      [survivorDoc.imageId, deadDoc.imageId].sort(),
    );
    const [oldJoin] = await getDb(ctx.db)
      .select({ deletedAt: entityAttachment.deletedAt })
      .from(entityAttachment)
      .where(eq(entityAttachment.id, deadDoc.joinId));
    expect(oldJoin?.deletedAt).not.toBeNull();

    expect((await chargeRow(dead))?.deletedAt).not.toBeNull();
    await expect(getPurchaseByID(ctx.db, dead)).rejects.toMatchObject({
      reason: "PURCHASE_NOT_FOUND",
    });

    // The folded charge's money moved to the survivor, it did not disappear
    // with the charge.
    expect(await liveExpenseTotal()).toBe(moneyBefore);
  });

  it("writes the full audit trail for a merge that folds a charge", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "Audited Keeper");
    const loser = await findOrCreateVendor(ctx.db, "audited keeper");

    const survivor = await charge(keeper, "AUD-1");
    const dead = await charge(loser, "AUD-1");
    const movedLine = await addLine("moved line", 12, dead);

    await mergeVendors(
      ctx.db,
      { keepId: await vendorCode(keeper), mergeIds: [await vendorCode(loser)] },
      ctx.actor,
    );

    // Every re-pointed expense records which charge it left and which it joined,
    // so the money's movement is reconstructible from the log alone.
    // `createExpense`/`addLine` hand back both the public `output` (shortcode
    // `id`) and the internal `entityId` uuid the audit log's `entityId` keys on.
    const [expenseEntry] = await auditRows(
      "expense",
      movedLine.entityId,
      "update",
    );
    expect(expenseEntry?.changes?.purchaseId).toEqual({
      from: dead,
      to: survivor,
    });

    expect(await auditRows("purchase", dead, "delete")).toHaveLength(1);
    const [survivorEntry] = await auditRows("purchase", survivor, "update");
    expect(survivorEntry?.changes?.foldedIn).toEqual({ from: null, to: dead });

    expect(await auditRows("vendor", loser, "delete")).toHaveLength(1);
    const [keeperEntry] = await auditRows("vendor", keeper, "update");
    expect(keeperEntry?.changes?.mergedFrom).toEqual({
      from: null,
      to: [loser],
    });
    expect(keeperEntry?.changes?.foldedCharges).toEqual({
      from: null,
      to: [dead],
    });
  });
});
