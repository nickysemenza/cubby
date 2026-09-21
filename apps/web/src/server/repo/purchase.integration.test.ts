import type {
  ExpenseId,
  ExpenseShortcode,
  PurchaseId,
  PurchaseShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  type ExpenseOut,
  expenseCreateInput,
  projectCreateInput,
} from "@cubby/schemas/project";
import {
  purchaseCreateInput,
  reconcilePurchase,
  splitExpenseInput,
} from "@cubby/schemas/purchase";
import { and, eq } from "drizzle-orm";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import {
  auditLog,
  expense,
  image,
  purchase,
  purchaseImage,
} from "~/server/db/schema";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import {
  attachPurchaseProductsWorkflow,
  detachPurchaseProductsWorkflow,
  linkExpensesToPurchaseWorkflow,
  mergePurchasesWorkflow,
  purchaseProductsWorkflow,
  splitExpenseWorkflow,
} from "~/server/workflows/purchase.server";

import { getDb, insertAndReturn } from "./database-helpers";
import { createExpense, getExpenseByShortcode } from "./expense";
import { createProduct } from "./product";
import { createProject } from "./project";
import {
  createPurchase,
  deleteEmptyPurchases,
  deletePurchases,
  findOrCreatePurchase,
  getPurchaseByID,
  getPurchaseByShortcode,
  getPurchaseExpenses,
  mergePurchases,
  previewMergePurchases,
  purchaseList,
  splitExpense,
  updatePurchase,
} from "./purchase";
import { makeExpenseInput, makeProductInput } from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { insertWithShortcode } from "./shortcode-utils";
import { findOrCreateVendor, getVendorByID } from "./vendor";

/**
 * `Purchase` is ONE vendor transaction. All money lives on `Expense`; a charge
 * only carries identity (`vendorId` + optional `orderId`), a date, documents,
 * and `statedTotal` — a reconciliation cue that is NEVER summed into spend.
 *
 * The load-bearing constraint under most of this file is the partial-unique
 * `(vendorId, orderId) WHERE orderId IS NOT NULL AND live` index: one order is
 * one charge, while many `(vendorId, null)` charges coexist.
 */

const page = { pageIndex: 0, pageSize: 100 };

describe("purchase application workflows", () => {
  const ctx = withTestDb();
  it("preserves expense amounts and product links through link, split, and merge", async () => {
    const context = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const vendorId = await vendorShortcodeByName(ctx.db, "Workflow supplies");
    const { output: keep } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId,
        date: "2026-08-01",
        orderId: "WORKFLOW-KEEP",
      }),
      ctx.actor,
    );
    const { output: source } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId,
        date: "2026-08-01",
        orderId: null,
      }),
      ctx.actor,
    );
    const { output: original } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Combined supplies",
        cost: 12,
        costType: "materials",
        trade: "other",
        date: "2026-08-01",
      }),
      ctx.actor,
    );
    await linkExpensesToPurchaseWorkflow(context, {
      purchaseId: source.id,
      expenseIds: [original.id],
    });
    expect((await expenseByShortcode(ctx.db, original.id)).purchaseId).toBe(
      source.id,
    );
    const parts = await splitExpenseWorkflow(
      context,
      splitExpenseInput.parse({
        expenseId: original.id,
        parts: [
          {
            name: "First supply",
            cost: 5,
            costType: "materials",
            trade: "other",
          },
          {
            name: "Second supply",
            cost: 7,
            costType: "materials",
            trade: "other",
          },
        ],
      }),
    );
    expect(parts.map((part) => part.cost).sort()).toEqual([5, 7]);
    expect(await getExpenseByShortcode(ctx.db, original.id)).toBeNull();
    const item = await createProduct(
      ctx.db,
      makeProductInput({ name: "Workflow durable item" }),
      ctx.actor,
    );
    await attachPurchaseProductsWorkflow(context, {
      purchaseId: source.id,
      productIds: [item.id],
    });
    expect(
      (await purchaseProductsWorkflow(context, { purchaseId: source.id })).map(
        (row) => row.productId,
      ),
    ).toEqual([item.id]);
    const merged = await mergePurchasesWorkflow(context, {
      keepId: keep.id,
      mergeIds: [source.id],
    });
    expect(merged.purchase.id).toBe(keep.id);
    expect(await getPurchaseByShortcode(ctx.db, source.id)).toBeNull();
    for (const part of parts) {
      const saved = await expenseByShortcode(ctx.db, part.id);
      expect(saved.purchaseId).toBe(keep.id);
      expect(saved.cost).toBe(part.cost);
    }
    expect(
      (await purchaseProductsWorkflow(context, { purchaseId: keep.id })).map(
        (row) => row.productId,
      ),
    ).toEqual([item.id]);
    await detachPurchaseProductsWorkflow(context, {
      purchaseId: keep.id,
      productIds: [item.id],
    });
    expect(
      await purchaseProductsWorkflow(context, { purchaseId: keep.id }),
    ).toEqual([]);
  });
});

const purchaseUuid = async (
  db: Database,
  shortcode: PurchaseShortcode,
): Promise<PurchaseId> => {
  const id = await resolveLiveShortcode(db, shortcode, "purchase");
  if (!id) throw new Error(`test setup: purchase ${shortcode} did not resolve`);
  return parseEntityId("purchase", id);
};

const expenseUuid = async (
  db: Database,
  shortcode: ExpenseShortcode,
): Promise<ExpenseId> => {
  const id = await resolveLiveShortcode(db, shortcode, "expense");
  if (!id) throw new Error(`test setup: expense ${shortcode} did not resolve`);
  return parseEntityId("expense", id);
};

const vendorShortcodeByName = async (
  db: Database,
  name: string,
): Promise<VendorShortcode> => {
  const id = await findOrCreateVendor(db, name);
  return (await getVendorByID(db, id)).id;
};

const expenseByShortcode = async (
  db: Database,
  shortcode: ExpenseShortcode,
): Promise<ExpenseOut> => {
  const row = await getExpenseByShortcode(db, shortcode);
  if (!row) throw new Error(`test setup: expense ${shortcode} not found`);
  return row;
};

describe("purchase repository — findOrCreatePurchase", () => {
  const ctx = withTestDb();

  it("is idempotent for one (vendorId, orderId) pair", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Amazon");

    const first = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: "111-1234567-1234567",
      date: "2024-03-01",
    });
    const again = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: "111-1234567-1234567",
      date: "2024-03-01",
    });
    const padded = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: "  111-1234567-1234567  ",
      date: "2024-03-01",
    });

    expect(again).toBe(first);
    expect(padded).toBe(first);
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(1);
    expect((await getPurchaseByID(ctx.db, first)).date).toBe("2024-03-01");
  });

  it("two concurrent calls for one order produce exactly one purchase", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Home Depot");

    const [a, b] = await Promise.all([
      findOrCreatePurchase(ctx.db, {
        vendorId,
        orderId: "WN63446464",
        date: "2024-03-01",
      }),
      findOrCreatePurchase(ctx.db, {
        vendorId,
        orderId: "WN63446464",
        date: "2024-03-01",
      }),
    ]);

    expect(a).toBe(b);
    const rows = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "WN63446464"));
    expect(rows).toHaveLength(1);
  });
});

describe("purchase repository — splitExpense", () => {
  const ctx = withTestDb();

  it("files the parts against the same charge, soft-deletes the original, and seeds statedTotal", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "split project" }),
      ctx.actor,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Combo Saw", manufacturer: "test" }),
      ctx.actor,
    );

    const { output: combo } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "combo kit",
          cost: 100,
          date: "2024-06-01",
          vendor: "Direct Tools Outlet",
          orderId: "DTO-SPLIT",
        }),
      ),
      ctx.actor,
    );
    const chargeId = combo.purchaseId!;
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);
    const comboUuid = await expenseUuid(ctx.db, combo.id);
    expect((await getPurchaseByID(ctx.db, chargeUuid)).statedTotal).toBeNull();

    const { items: parts, priceAffectedProductIds } = await splitExpense(
      ctx.db,
      splitExpenseInput.parse({
        expenseId: combo.id,
        parts: [
          {
            name: "saw portion",
            cost: 70,
            costType: "tools",
            trade: "cabinetry",
            projectId: project.id,
            productId: product.id,
          },
          {
            name: "blade portion",
            cost: 30,
            costType: "materials",
            trade: "other",
          },
        ],
      }),
      ctx.actor,
    );

    expect(parts).toHaveLength(2);
    expect(priceAffectedProductIds).toEqual([]);
    for (const part of parts) {
      expect(part.purchaseId).toBe(chargeId);
      expect(part.vendor).toBe("Direct Tools Outlet");
      expect(part.orderId).toBe("DTO-SPLIT");
      expect(part.date).toBe("2024-06-01");
    }

    const saw = parts.find((p) => p.name === "saw portion");
    const blade = parts.find((p) => p.name === "blade portion");
    expect(saw).toBeDefined();
    expect(blade).toBeDefined();
    expect(saw?.costType).toBe("tools");
    expect(saw?.trade).toBe("cabinetry");
    expect(saw?.projectId).toBe(project.id);
    expect(saw?.productId).toBe(product.id);
    expect(blade?.costType).toBe("materials");
    expect(blade?.trade).toBe("other");
    expect(blade?.projectId).toBeNull();
    expect(blade?.productId).toBeNull();

    const [originalRow] = await getDb(ctx.db)
      .select({ deletedAt: expense.deletedAt })
      .from(expense)
      .where(eq(expense.id, comboUuid));
    expect(originalRow?.deletedAt).not.toBeNull();
    const lines = await getPurchaseExpenses(ctx.db, chargeUuid);
    expect(lines.map((l) => l.id).sort()).toEqual(
      parts.map((p) => p.id).sort(),
    );

    const charge = await getPurchaseByID(ctx.db, chargeUuid);
    expect(charge.statedTotal).toBe(100);
    expect(charge.expenseTotal).toBe(100);
    expect(reconcilePurchase(charge)).toBe("match");
  });

  it("refuses a split that would change the source amount", async () => {
    const { output: combo } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "mismatch source",
          cost: 100,
          vendor: "Mismatch Depot",
          orderId: "MM-1",
        }),
      ),
      ctx.actor,
    );
    const chargeId = combo.purchaseId!;
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);

    // Regression: replacing a ledger row must not silently lose fifteen dollars.
    await expect(
      splitExpense(
        ctx.db,
        splitExpenseInput.parse({
          expenseId: combo.id,
          parts: [
            {
              name: "kept portion",
              cost: 60,
              costType: "materials",
              trade: "other",
            },
            {
              name: "refunded portion",
              cost: 25,
              costType: "materials",
              trade: "other",
            },
          ],
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });

    const charge = await getPurchaseByID(ctx.db, chargeUuid);
    expect(charge.statedTotal).toBeNull();
    expect(
      (await getPurchaseExpenses(ctx.db, chargeUuid)).reduce(
        (sum, l) => sum + (l.cost ?? 0),
        0,
      ),
    ).toBe(100);
    expect(charge.expenseTotal).toBe(100);
    expect(await getExpenseByShortcode(ctx.db, combo.id)).toMatchObject({
      cost: 100,
    });
  });
});

describe("purchase repository — mergePurchases", () => {
  const ctx = withTestDb();

  const attachDocumentRow = async (
    purchaseShortcodeId: PurchaseShortcode,
    label: string,
  ) => {
    const purchaseIdUuid = await purchaseUuid(ctx.db, purchaseShortcodeId);
    const img = await insertWithShortcode(ctx.db, "image", {
      key: `test-documents/${label}.pdf`,
      filename: `${label}.pdf`,
      contentType: "application/pdf",
      size: 100,
      status: "UPLOADED",
    });
    const join = await insertAndReturn(ctx.db, purchaseImage, {
      purchaseId: purchaseIdUuid,
      imageId: img.id,
    });
    return { imageId: img.id, joinId: join.id };
  };

  it("re-points expenses, moves documents, and soft-deletes the loser", async () => {
    const vendorId = await vendorShortcodeByName(ctx.db, "Merge Vendor");
    const { output: keeper } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, date: "2024-01-01" }),
      ctx.actor,
    );
    const { output: loser } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, date: "2024-01-02" }),
      ctx.actor,
    );

    const { output: keeperLine } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "keeper line",
          cost: 10,
          purchaseId: keeper.id,
        }),
      ),
      ctx.actor,
    );
    const { output: loserLine } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "loser line",
          cost: 20,
          purchaseId: loser.id,
        }),
      ),
      ctx.actor,
    );
    const loserDoc = await attachDocumentRow(loser.id, "loser-invoice");

    const merged = await mergePurchases(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    expect(merged.purchase.id).toBe(keeper.id);
    const keeperUuid = await purchaseUuid(ctx.db, keeper.id);

    const lines = await getPurchaseExpenses(ctx.db, keeperUuid);
    expect(lines.map((l) => l.id).sort()).toEqual(
      [keeperLine.id, loserLine.id].sort(),
    );

    // Documents follow their charge: a new join row against the keeper, and the
    // loser's own row tombstoned in the same transaction.
    const keeperDocs = await getDb(ctx.db).query.purchaseImage.findMany({
      where: and(
        eq(purchaseImage.purchaseId, keeperUuid),
        eq(purchaseImage.imageId, loserDoc.imageId),
      ),
    });
    expect(keeperDocs).toHaveLength(1);
    expect(keeperDocs[0]?.deletedAt).toBeNull();

    const [oldJoin] = await getDb(ctx.db)
      .select({ deletedAt: purchaseImage.deletedAt })
      .from(purchaseImage)
      .where(eq(purchaseImage.id, loserDoc.joinId));
    expect(oldJoin?.deletedAt).not.toBeNull();

    // The loser is gone even at the public boundary: a soft-deleted shortcode
    // resolves to nothing rather than throwing a uuid-keyed NOT_FOUND.
    expect(await getPurchaseByShortcode(ctx.db, loser.id)).toBeNull();

    // The keeper's rollup now covers both sides' money.
    expect(merged.purchase.expenseCount).toBe(2);
    expect(merged.purchase.expenseTotal).toBe(30);
  });

  it("previews settlement movement and audits each absorbed purchase once", async () => {
    const vendorId = await vendorShortcodeByName(ctx.db, "Settlement Merge");
    const createCharge = (date: string) =>
      createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId, date }),
        ctx.actor,
      );
    const { output: keeper } = await createCharge("2024-02-01");
    const { output: loserA } = await createCharge("2024-02-02");
    const { output: loserB } = await createCharge("2024-02-03");
    const keeperId = await purchaseUuid(ctx.db, keeper.id);
    const loserIds = await Promise.all(
      [loserA.id, loserB.id].map((id) => purchaseUuid(ctx.db, id)),
    );
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Settlement Merge Card",
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
      },
      cardNumbers: [
        {
          last4: "4242",
          kind: "primary",
          validFrom: null,
          validTo: null,
          note: null,
        },
      ],
      provisional: false,
      sourceAliases: [],
      notes: null,
    });
    for (const [index, purchaseId] of loserIds.entries()) {
      await insertSettlementTransaction(ctx.db, {
        accountId: account.id,
        purchaseId,
        kind: "purchase",
        status: "posted",
        amount: index + 1,
        transactionDate: `2024-02-0${index + 2}`,
        postedDate: `2024-02-0${index + 3}`,
        merchant: "Settlement Merge",
        rawDescription: null,
        sourceCategory: null,
        sourceRefs: [],
        notes: null,
      });
    }

    const preview = await previewMergePurchases(ctx.db, {
      keepId: keeperId,
      mergeIds: loserIds,
    });
    expect(
      preview.changes.find(
        (item) => item.edgeKey === "FinancialTransactionAllocation.purchaseId",
      ),
    ).toMatchObject({
      label: "settlement allocations moved",
      total: 2,
      byTargetId: { [loserIds[0]!]: 1, [loserIds[1]!]: 1 },
    });

    await mergePurchases(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loserA.id, loserB.id] },
      ctx.actor,
    );
    for (const loserId of loserIds) {
      const deleteAudits = await getDb(ctx.db)
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityType, "purchase"),
            eq(auditLog.entityId, loserId),
            eq(auditLog.action, "delete"),
          ),
        );
      expect(deleteAudits).toHaveLength(1);
    }
  });
});

/**
 * `updatePurchase` is the one writer that can move BOTH halves of the
 * partial-unique `(vendorId, orderId)` key, so it is the one that can collide
 * with an existing charge. It pre-checks with a SELECT rather than letting 23505
 * surface as an untyped 500 — a failed statement would also poison the
 * transaction.
 */
describe("purchase repository — updatePurchase collision + liveness guards", () => {
  const ctx = withTestDb();

  it("raises PURCHASE_MERGE_ORDER_COLLISION when the target (vendor, orderId) slot is taken", async () => {
    const toolNirvana = await vendorShortcodeByName(ctx.db, "Tool Nirvana");
    const homeDepot = await vendorShortcodeByName(ctx.db, "Home Depot");
    // Order ids are only unique PER VENDOR, so "#11325" legitimately exists at
    // both retailers — which is exactly how a vendor move can collide.
    const { output: held } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2024-01-15",
        vendorId: homeDepot,
        orderId: "#11325",
      }),
      ctx.actor,
    );
    const { output: moving } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2024-01-15",
        vendorId: toolNirvana,
        orderId: "#11325",
      }),
      ctx.actor,
    );

    await expect(
      updatePurchase(ctx.db, moving.id, { vendorId: homeDepot }, ctx.actor),
    ).rejects.toMatchObject({
      reason: "PURCHASE_MERGE_ORDER_COLLISION",
    });
    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, moving.id)))
        .vendorId,
    ).toBe(toolNirvana);

    const { output: sibling } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2024-01-15",
        vendorId: homeDepot,
        orderId: "WN-1",
      }),
      ctx.actor,
    );
    await expect(
      updatePurchase(ctx.db, sibling.id, { orderId: "#11325" }, ctx.actor),
    ).rejects.toMatchObject({
      reason: "PURCHASE_MERGE_ORDER_COLLISION",
    });
    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, held.id)))
        .orderId,
    ).toBe("#11325");

    const { output: moved } = await updatePurchase(
      ctx.db,
      moving.id,
      { orderId: "TN-99" },
      ctx.actor,
    );
    expect(moved.orderId).toBe("TN-99");
  });
});

describe("purchase repository — deletion cascades", () => {
  const ctx = withTestDb();

  it("deletes an empty Purchase and its documents without detaching money", async () => {
    const vendorId = await vendorShortcodeByName(ctx.db, "Empty Delete Vendor");
    const { output: emptyPurchase } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId,
        date: "2024-01-15",
        orderId: "EMPTY-DELETE-1",
      }),
      ctx.actor,
    );
    const purchaseId = await purchaseUuid(ctx.db, emptyPurchase.id);
    const document = await insertWithShortcode(ctx.db, "image", {
      key: "test-documents/empty-delete.pdf",
      filename: "empty-delete.pdf",
      contentType: "application/pdf",
      size: 100,
      status: "UPLOADED",
    });
    const join = await insertAndReturn(ctx.db, purchaseImage, {
      purchaseId,
      imageId: document.id,
    });

    await expect(
      deleteEmptyPurchases(ctx.db, [emptyPurchase.id], ctx.actor),
    ).resolves.toEqual({
      shortcodes: [emptyPurchase.id],
      // Nothing else referenced the document, so the delete reaps it and hands
      // back the R2 key for the router to drop after the commit.
      detachedImageKeys: [document.key],
    });
    await expect(
      getPurchaseByShortcode(ctx.db, emptyPurchase.id),
    ).resolves.toBeNull();

    // The cascade soft-deletes the join row, then the reap hard-deletes it with
    // the file — a tombstone pointing at a deleted `Image` would strand the FK.
    expect(
      await getDb(ctx.db)
        .select()
        .from(purchaseImage)
        .where(eq(purchaseImage.id, join.id)),
    ).toHaveLength(0);
    expect(
      await getDb(ctx.db)
        .select()
        .from(image)
        .where(eq(image.shortcode, document.id)),
    ).toHaveLength(0);

    const auditRows = await getDb(ctx.db)
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "purchase"),
          eq(auditLog.entityId, purchaseId),
          eq(auditLog.action, "delete"),
        ),
      );
    expect(auditRows).toEqual([{ action: "delete" }]);
  });

  it("atomically refuses a delete-empty batch when any Purchase has spend", async () => {
    const vendorId = await vendorShortcodeByName(
      ctx.db,
      "Atomic Empty Delete Vendor",
    );
    const { output: emptyPurchase } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId,
        date: "2024-01-15",
        orderId: "ATOMIC-EMPTY",
      }),
      ctx.actor,
    );
    const { output: line } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "real spend",
          cost: 25,
          vendor: "Atomic Empty Delete Vendor",
          orderId: "ATOMIC-NONEMPTY",
        }),
      ),
      ctx.actor,
    );

    await expect(
      deleteEmptyPurchases(
        ctx.db,
        [emptyPurchase.id, line.purchaseId!],
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "PURCHASE_NOT_EMPTY" });

    await expect(
      getPurchaseByShortcode(ctx.db, emptyPurchase.id),
    ).resolves.not.toBeNull();
    const spendAfter = await expenseByShortcode(ctx.db, line.id);
    expect(spendAfter.cost).toBe(25);
    expect(spendAfter.purchaseId).toBe(line.purchaseId);
  });

  it("NULLS expense.purchaseId (never deletes spend) and soft-deletes its documents", async () => {
    const { output: line } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "surviving spend",
          cost: 250,
          vendor: "Delete Me Vendor",
          orderId: "DEL-1",
        }),
      ),
      ctx.actor,
    );
    const chargeId = line.purchaseId!;
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);

    const img = await insertWithShortcode(ctx.db, "image", {
      key: "test-documents/deleted-charge.pdf",
      filename: "deleted-charge.pdf",
      contentType: "application/pdf",
      size: 100,
      status: "UPLOADED",
    });
    const join = await insertAndReturn(ctx.db, purchaseImage, {
      purchaseId: chargeUuid,
      imageId: img.id,
    });

    await deletePurchases(ctx.db, [chargeId], ctx.actor);

    // An expense IS the money — deleting a charge must never delete spend. The
    // line survives at full cost and falls back to reading as "no vendor
    // recorded", which is exactly what it is once the charge is gone.
    const after = await expenseByShortcode(ctx.db, line.id);
    expect(after.cost).toBe(250);
    expect(after.purchaseId).toBeNull();
    expect(after.vendorId).toBeNull();
    expect(after.vendor).toBeNull();
    expect(after.orderId).toBeNull();

    // Removal-path invariant: the join rows go in the SAME transaction.
    const [joinRow] = await getDb(ctx.db)
      .select({ deletedAt: purchaseImage.deletedAt })
      .from(purchaseImage)
      .where(eq(purchaseImage.id, join.id));
    expect(joinRow?.deletedAt).not.toBeNull();
  });
});

/**
 * The load-bearing guard: attaching charges to expenses must be invisible to
 * every spend number in the app, and `statedTotal` must never reach one.
 */
/**
 * `resolvePurchaseSort` — the sort keys that are NOT columns on `Purchase`:
 * the joined vendor name and correlated rollups. The generic
 * column path can't produce them, so a regression here silently falls back to
 * the default order rather than erroring.
 */

/**
 * `computeChanges` diffs raw DB columns, so a moved FK like `vendorId` lands
 * in `AuditLog.changes` as the internal uuid — every existing row has it baked
 * in that way. `getAuditLog` resolves it to the public shortcode at READ time
 * (batched onto the same `lookupShortcodes` round-trip that already resolves
 * the entry's own `entityId`), which is the only fix that also covers history
 * instead of just new writes. See `EDGE_KEY_TARGET_ENTITY` in
 * `server/db/entity-incoming-edges.ts` — the (entityType, fieldName) → target
 * entity map this derives from `INCOMING_EDGES` rather than a second,
 * hand-kept table.
 */
