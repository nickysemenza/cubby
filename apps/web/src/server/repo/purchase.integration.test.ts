import type {
  ExpenseId,
  ExpenseShortcode,
  PurchaseId,
  PurchaseShortcode,
  VendorId,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  unsafeExpenseId,
  unsafePurchaseId,
  unsafePurchaseShortcode,
  unsafeVendorId,
} from "@cubby/schemas/identifiers";
import { isDocumentFile } from "@cubby/schemas/image";
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
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

// The only stubbed seam in this file: the R2 network PUT. Everything else in
// `attachFileToEntity` (target validation, PDF classification, key generation,
// the row + join insert) runs for real against the test database — mirroring
// image-storage.service.unit.test.ts, which mocks the same two functions.
vi.mock("~/server/utils/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/utils/s3")>()),
  uploadToS3: vi.fn(async () => undefined),
  deleteS3Object: vi.fn(async () => undefined),
}));

import type { Database } from "~/server/db";
import {
  expense,
  image,
  purchase,
  purchaseImage,
  vendor,
} from "~/server/db/schema";
import {
  attachFileToEntity,
  initiateDocumentUpload,
} from "~/server/services/image-storage.service";
import { getDb, insertAndReturn } from "./database-helpers";
import {
  createExpense,
  deleteExpenses,
  expenseAnalytics,
  expenseList,
  getExpenseByShortcode,
} from "./expense";
import { createProduct } from "./product";
import {
  createProject,
  projectDashboardSummary,
  projectPortfolioAnalytics,
} from "./project";
import { projectRollups } from "./project/analytics";
import {
  createPurchase,
  deletePurchases,
  findOrCreatePurchase,
  getPurchaseByID,
  getPurchaseByShortcode,
  getPurchaseExpenses,
  linkExpensesToPurchase,
  mergePurchases,
  purchaseList,
  splitExpense,
  updatePurchase,
} from "./purchase";
import { makeExpenseInput, makeProductInput } from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { deleteVendors, findOrCreateVendor, getVendorByID } from "./vendor";

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

/**
 * Shortcode ⇄ uuid bridges for this test file. Post-cutover, `PurchaseOut`,
 * `ExpenseOut` and `VendorOut` speak PUBLIC shortcodes only — but a handful of
 * internal reads (`getPurchaseByID`, `getPurchaseExpenses`) and this file's
 * own white-box raw-schema assertions still key on the private uuid (see the
 * root CLAUDE.md note on shortcodes being the public id). These collapse the
 * `resolveLiveShortcode` + `unsafe*Id` dance to one call per direction instead
 * of hand-rolling it at every call site.
 */
const purchaseUuid = async (
  db: Database,
  shortcode: PurchaseShortcode,
): Promise<PurchaseId> => {
  const id = await resolveLiveShortcode(db, shortcode, "purchase");
  if (!id) throw new Error(`test setup: purchase ${shortcode} did not resolve`);
  return unsafePurchaseId(id);
};

const vendorUuid = async (
  db: Database,
  shortcode: VendorShortcode,
): Promise<VendorId> => {
  const id = await resolveLiveShortcode(db, shortcode, "vendor");
  if (!id) throw new Error(`test setup: vendor ${shortcode} did not resolve`);
  return unsafeVendorId(id);
};

const expenseUuid = async (
  db: Database,
  shortcode: ExpenseShortcode,
): Promise<ExpenseId> => {
  const id = await resolveLiveShortcode(db, shortcode, "expense");
  if (!id) throw new Error(`test setup: expense ${shortcode} did not resolve`);
  return unsafeExpenseId(id);
};

/** `findOrCreateVendor` hands back the internal uuid; `purchaseCreateInput`,
 * `updatePurchase`'s `data.vendorId`, and `PurchaseOut.vendorId` are all public
 * shortcodes now. Collapses the "create by name, get its shortcode" idiom used
 * throughout this file. */
const vendorShortcodeByName = async (
  db: Database,
  name: string,
): Promise<VendorShortcode> => {
  const id = await findOrCreateVendor(db, name);
  return (await getVendorByID(db, id)).id;
};

/** Every expense read in this file expects the row to be live — a throwing
 * wrapper around the shortcode-keyed reader, mirroring the throwing contract
 * `getExpenseByID` used to give this file before `ExpenseOut.id` became a
 * shortcode. */
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
    });
    // Trimmed before matching, so a padded id from a scraped receipt resolves to
    // the charge already on file rather than creating a second one.
    const padded = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: "  111-1234567-1234567  ",
    });

    expect(again).toBe(first);
    expect(padded).toBe(first);
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(1);
    // Re-resolution never rewrites the charge it found — the date from the
    // first sighting survives.
    expect((await getPurchaseByID(ctx.db, first)).date).toBe("2024-03-01");
  });

  it("never merges two vendors that share an order-id string", async () => {
    // An order id is only unique WITHIN a vendor. Short ones — Tool Nirvana's
    // "#11325" — genuinely collide with other retailers, which is exactly what
    // the two-column partial-unique index exists to keep apart.
    const toolNirvana = await findOrCreateVendor(ctx.db, "Tool Nirvana");
    const otherStore = await findOrCreateVendor(ctx.db, "Metal Supermarkets");

    const a = await findOrCreatePurchase(ctx.db, {
      vendorId: toolNirvana,
      orderId: "#11325",
    });
    const b = await findOrCreatePurchase(ctx.db, {
      vendorId: otherStore,
      orderId: "#11325",
    });

    expect(b).not.toBe(a);
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(2);

    const chargeA = await getPurchaseByID(ctx.db, a);
    const chargeB = await getPurchaseByID(ctx.db, b);
    expect(chargeA.vendorId).toBe(
      (await getVendorByID(ctx.db, toolNirvana)).id,
    );
    expect(chargeB.vendorId).toBe((await getVendorByID(ctx.db, otherStore)).id);
    // Each charge resolves its OWN vendor name through the join.
    expect(chargeA.vendorName).toBe("Tool Nirvana");
    expect(chargeB.vendorName).toBe("Metal Supermarkets");
  });

  it("two concurrent calls for one order produce exactly one purchase", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Home Depot");

    // This is what `findOrCreate`'s `ON CONFLICT DO NOTHING` + re-select is FOR:
    // two concurrent imports of one order must land on a single charge instead of
    // 500ing on `Purchase_vendorId_orderId_key`.
    const [a, b] = await Promise.all([
      findOrCreatePurchase(ctx.db, { vendorId, orderId: "WN63446464" }),
      findOrCreatePurchase(ctx.db, { vendorId, orderId: "WN63446464" }),
    ]);

    expect(a).toBe(b);
    const rows = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "WN63446464"));
    expect(rows).toHaveLength(1);
  });

  it("orderId: null ALWAYS creates a new charge", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Masseria Calderisi");

    const first = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: null,
      date: "2024-05-01",
    });
    const second = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: null,
      date: "2024-05-01",
    });
    // Empty string is order-id-absent, not an order id — same "always new" rule.
    const blank = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: "  ",
    });

    // DELIBERATE, and not a bug to "fix" later: `(vendorId, null)` is not
    // unique, and grouping by `(vendor, date)` instead would have falsely merged
    // 71 real ledger rows across 31 groups. Two progress payments to one
    // contractor on one day are TWO charges. Merging near-duplicates is
    // `mergePurchases` — a user action, never a guess on the write path.
    expect(second).not.toBe(first);
    expect(blank).not.toBe(first);
    expect(blank).not.toBe(second);
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(3);
    for (const id of [first, second, blank]) {
      expect((await getPurchaseByID(ctx.db, id)).orderId).toBeNull();
    }
  });
});

describe("purchase repository — charge resolution from {vendor, orderId}", () => {
  const ctx = withTestDb();

  it("creates the vendor + charge on first use and REUSES both on the second", async () => {
    // The unchanged input shape is the point of the split: MCP, quick-add and
    // the purchase-import skill never learned about vendor or purchase ids.
    const { output: first } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "reuse line one",
          cost: 40,
          vendor: "Direct Tools Outlet",
          orderId: "DTO-9001",
        }),
      ),
      ctx.actor,
    );
    const { output: second } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "reuse line two",
          cost: 60,
          vendor: "Direct Tools Outlet",
          orderId: "DTO-9001",
        }),
      ),
      ctx.actor,
    );

    expect(first.purchaseId).not.toBeNull();
    expect(first.vendorId).not.toBeNull();
    expect(second.purchaseId).toBe(first.purchaseId);
    expect(second.vendorId).toBe(first.vendorId);

    // `vendor` / `orderId` are no longer columns — they read back through the
    // charge join, under the same output keys they always had.
    expect(first.vendor).toBe("Direct Tools Outlet");
    expect(first.orderId).toBe("DTO-9001");
    expect(second.vendor).toBe("Direct Tools Outlet");
    expect(second.orderId).toBe("DTO-9001");

    // One vendor, one charge, two lines.
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(1);
    const lines = await getPurchaseExpenses(
      ctx.db,
      await purchaseUuid(ctx.db, first.purchaseId!),
    );
    expect(lines.map((l) => l.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("a vendor with NO orderId gets its own charge each time", async () => {
    const { output: walkInA } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "counter sale a", vendor: "Tool Nirvana" }),
      ),
      ctx.actor,
    );
    const { output: walkInB } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "counter sale b", vendor: "Tool Nirvana" }),
      ),
      ctx.actor,
    );

    expect(walkInA.purchaseId).not.toBeNull();
    expect(walkInB.purchaseId).not.toBeNull();
    expect(walkInB.purchaseId).not.toBe(walkInA.purchaseId);
    // Same vendor either way — only the charge differs.
    expect(walkInB.vendorId).toBe(walkInA.vendorId);
    expect(walkInA.orderId).toBeNull();
  });

  it("no vendor at all gets purchaseId: null, and a lone orderId is dropped", async () => {
    const { output: chargeless } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "cash, no receipt", vendor: null }),
      ),
      ctx.actor,
    );
    expect(chargeless.purchaseId).toBeNull();
    expect(chargeless.vendorId).toBeNull();

    // An order id ALONE can't name a transaction (they're unique only per
    // vendor), so it is dropped rather than half-recorded as a charge nobody
    // could identify.
    const { output: orphanOrderId } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "order id, no vendor",
          vendor: null,
          orderId: "WN-no-vendor",
        }),
      ),
      ctx.actor,
    );
    expect(orphanOrderId.purchaseId).toBeNull();
    expect(orphanOrderId.vendorId).toBeNull();
    expect(orphanOrderId.orderId).toBeNull();
    // Nothing was created on the side either.
    expect((await purchaseList(ctx.db, {}, [], page)).count).toBe(0);
  });
});

describe("purchase repository — linkExpensesToPurchase", () => {
  const ctx = withTestDb();

  it("attaches order-less expenses to one charge (the contractor case)", async () => {
    // Flow Form Plumbing's single invoice covering rough-in AND fixtures: one
    // charge, two trades, and no order id anywhere — the shape this whole model
    // exists to serve.
    const { output: roughIn } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "plumbing rough-in",
          cost: 1516,
          trade: "plumbing",
        }),
      ),
      ctx.actor,
    );
    const { output: fixtures } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "fixtures", cost: 1000, trade: "plumbing" }),
      ),
      ctx.actor,
    );
    expect(roughIn.purchaseId).toBeNull();
    expect(fixtures.orderId).toBeNull();

    const vendorId = await vendorShortcodeByName(ctx.db, "Flow Form Plumbing");
    const { output: charge } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId,
        date: "2024-04-10",
        statedTotal: 2516,
      }),
      ctx.actor,
    );

    const after = await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: charge.id, expenseIds: [roughIn.id, fixtures.id] },
      ctx.actor,
    );

    const lines = await getPurchaseExpenses(
      ctx.db,
      await purchaseUuid(ctx.db, charge.id),
    );
    expect(lines.map((l) => l.id).sort()).toEqual(
      [roughIn.id, fixtures.id].sort(),
    );

    // Both lines now read the vendor through the charge, still with no order id.
    const reread = await expenseByShortcode(ctx.db, roughIn.id);
    expect(reread.purchaseId).toBe(charge.id);
    expect(reread.vendor).toBe("Flow Form Plumbing");
    expect(reread.orderId).toBeNull();

    // The charge's own rollup sees both lines, and the invoice reconciles.
    expect(after.expenseCount).toBe(2);
    expect(after.expenseTotal).toBe(2516);
    expect(reconcilePurchase(after)).toBe("match");
  });

  it("re-points a line that already had a different charge", async () => {
    const { output: line } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "misfiled line", cost: 12, vendor: "Amazon" }),
      ),
      ctx.actor,
    );
    const originalCharge = line.purchaseId;
    expect(originalCharge).not.toBeNull();

    const vendorId = await vendorShortcodeByName(ctx.db, "Amazon Business");
    const { output: target } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, orderId: "AB-1" }),
      ctx.actor,
    );

    await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: target.id, expenseIds: [line.id] },
      ctx.actor,
    );

    expect((await expenseByShortcode(ctx.db, line.id)).purchaseId).toBe(
      target.id,
    );
    expect(
      await getPurchaseExpenses(
        ctx.db,
        await purchaseUuid(ctx.db, originalCharge!),
      ),
    ).toHaveLength(0);
  });

  it("refuses an unknown charge, and no-ops on a selection with no live lines", async () => {
    const { output: line } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "link guard line", cost: 9 }),
      ),
      ctx.actor,
    );

    // An FK would accept any existing row; this is the tombstone/nonexistent check.
    await expect(
      linkExpensesToPurchase(
        ctx.db,
        {
          purchaseId: unsafePurchaseShortcode("PUR-9999"),
          expenseIds: [line.id],
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });

    const vendorId = await vendorShortcodeByName(ctx.db, "Link Guard Vendor");
    const { output: target } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, orderId: "LG-1" }),
      ctx.actor,
    );
    await deleteExpenses(ctx.db, [line.id], ctx.actor);

    // Every named line is soft-deleted, so the write is skipped entirely rather
    // than running an unbounded update — and the charge is returned untouched.
    const unchanged = await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: target.id, expenseIds: [line.id] },
      ctx.actor,
    );
    expect(unchanged.expenseCount).toBe(0);
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
    // Resolved while everything is still live — `combo` (and its charge) survive
    // this test, but the ORIGINAL expense row is soft-deleted by `splitExpense`
    // below, so its own uuid must be captured before that happens.
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);
    const comboUuid = await expenseUuid(ctx.db, combo.id);
    // `findOrCreatePurchase` records no stated total, so the split has something
    // to seed.
    expect((await getPurchaseByID(ctx.db, chargeUuid)).statedTotal).toBeNull();

    const parts = await splitExpense(
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
    // Every part lands on the SAME charge — parts of one purchase must share one
    // parent.
    for (const part of parts) {
      expect(part.purchaseId).toBe(chargeId);
      expect(part.vendor).toBe("Direct Tools Outlet");
      expect(part.orderId).toBe("DTO-SPLIT");
      // Non-part fields are inherited from the original.
      expect(part.date).toBe("2024-06-01");
    }

    // Each part keeps its OWN trade / costType / project / product — that's the
    // point: a combo-kit charge's saw half is `tools` and its blade half is
    // `materials`.
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

    // The original row is gone from every read path.
    const [originalRow] = await getDb(ctx.db)
      .select({ deletedAt: expense.deletedAt })
      .from(expense)
      .where(eq(expense.id, comboUuid));
    expect(originalRow?.deletedAt).not.toBeNull();
    const lines = await getPurchaseExpenses(ctx.db, chargeUuid);
    expect(lines.map((l) => l.id).sort()).toEqual(
      parts.map((p) => p.id).sort(),
    );

    // `statedTotal` is seeded from the original cost so the parts have something
    // to reconcile against.
    const charge = await getPurchaseByID(ctx.db, chargeUuid);
    expect(charge.statedTotal).toBe(100);
    expect(charge.expenseTotal).toBe(100);
    expect(reconcilePurchase(charge)).toBe("match");
  });

  it("does not overwrite a statedTotal the charge already had", async () => {
    const vendorId = await vendorShortcodeByName(ctx.db, "Stated Total Vendor");
    const { output: charge } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, statedTotal: 431.24 }),
      ctx.actor,
    );
    const { output: line } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "one line",
          cost: 431.24,
          purchaseId: charge.id,
        }),
      ),
      ctx.actor,
    );

    await splitExpense(
      ctx.db,
      splitExpenseInput.parse({
        expenseId: line.id,
        parts: [
          { name: "part a", cost: 200, costType: "materials", trade: "other" },
          {
            name: "part b",
            cost: 231.24,
            costType: "materials",
            trade: "other",
          },
        ],
      }),
      ctx.actor,
    );

    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, charge.id)))
        .statedTotal,
    ).toBe(431.24);
  });

  it("ACCEPTS a deliberately mismatched sum and merely reports it", async () => {
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

    // 60 + 25 = 85 against a $100 charge. Nothing validates that the parts add
    // up, so this write must SUCCEED — a partial refund reduces a line without
    // changing what the charge stated, so a mismatch is frequently correct.
    const parts = await splitExpense(
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
    );
    expect(parts.map((p) => p.cost).sort()).toEqual([25, 60]);

    const charge = await getPurchaseByID(ctx.db, chargeUuid);
    // Nothing back-computed a cost: the stated total is still the original 100
    // and the lines still sum to 85. The disagreement is REPORTED, not fixed.
    expect(charge.statedTotal).toBe(100);
    expect(
      (await getPurchaseExpenses(ctx.db, chargeUuid)).reduce(
        (sum, l) => sum + (l.cost ?? 0),
        0,
      ),
    ).toBe(85);
    expect(charge.expenseTotal).toBe(85);
    expect(reconcilePurchase(charge)).toBe("mismatch");

    // The soft worklist that surfaces this now lives in Problems
    // (`findChargesNotReconciling`), which does the comparison in SQL — see
    // problems.integration.test.ts. `reconcilePurchase` above is the shared
    // verdict both sides use, so asserting it here is asserting the same rule.
  });

  it("refuses to split an expense with no charge attached", async () => {
    const { output: chargeless } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "no vendor line", cost: 50 }),
      ),
      ctx.actor,
    );

    await expect(
      splitExpense(
        ctx.db,
        splitExpenseInput.parse({
          expenseId: chargeless.id,
          parts: [
            { name: "a", cost: 25, costType: "materials", trade: "other" },
            { name: "b", cost: 25, costType: "materials", trade: "other" },
          ],
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({ cause: { reason: "PURCHASE_NOT_FOUND" } });
  });
});

describe("purchase repository — mergePurchases", () => {
  const ctx = withTestDb();

  /** An UPLOADED image + its `PurchaseImage` join row, filed against `id`. */
  const attachDocumentRow = async (
    purchaseShortcodeId: PurchaseShortcode,
    label: string,
  ) => {
    const purchaseIdUuid = await purchaseUuid(ctx.db, purchaseShortcodeId);
    const img = await insertAndReturn(ctx.db, image, {
      key: `test-documents/${label}.pdf`,
      url: `https://example.com/${label}.pdf`,
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

    expect(merged.id).toBe(keeper.id);
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
    expect(merged.expenseCount).toBe(2);
    expect(merged.expenseTotal).toBe(30);
  });

  it("lets the keeper ADOPT a loser's order id when it had none", async () => {
    // The common shape: a hand-entered charge later matched to a vendor export.
    const vendorId = await vendorShortcodeByName(ctx.db, "Adopt Vendor");
    const { output: keeper } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, orderId: null }),
      ctx.actor,
    );
    const { output: loser } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, orderId: "ADOPT-1" }),
      ctx.actor,
    );

    const merged = await mergePurchases(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    expect(merged.orderId).toBe("ADOPT-1");
    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, keeper.id)))
        .orderId,
    ).toBe("ADOPT-1");
  });

  it("refuses to merge across vendors", async () => {
    const vendorA = await vendorShortcodeByName(ctx.db, "Vendor A");
    const vendorB = await vendorShortcodeByName(ctx.db, "Vendor B");
    const { output: keeper } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId: vendorA }),
      ctx.actor,
    );
    const { output: other } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId: vendorB }),
      ctx.actor,
    );

    // Re-pointing a charge to another vendor would silently rewrite who was
    // paid. Merging is a grouping operation, not a correction.
    await expect(
      mergePurchases(
        ctx.db,
        { keepId: keeper.id, mergeIds: [other.id] },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "PURCHASE_MERGE_VENDOR_MISMATCH" },
    });

    // Nothing moved.
    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, other.id)))
        .vendorId,
    ).toBe(vendorB);
  });

  it("refuses when both sides carry a non-null order id", async () => {
    const vendorId = await vendorShortcodeByName(ctx.db, "Two Orders Vendor");
    const { output: keeper } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, orderId: "ORD-1" }),
      ctx.actor,
    );
    const { output: loser } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, orderId: "ORD-2" }),
      ctx.actor,
    );

    // The partial-unique index means both can't survive, and two real order ids
    // are two real transactions — a no-op, not a merge.
    await expect(
      mergePurchases(
        ctx.db,
        { keepId: keeper.id, mergeIds: [loser.id] },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "PURCHASE_MERGE_ORDER_COLLISION" },
    });

    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, keeper.id)))
        .orderId,
    ).toBe("ORD-1");
    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, loser.id)))
        .orderId,
    ).toBe("ORD-2");
  });

  it("a self-merge (or an empty merge set) returns the keeper untouched", async () => {
    const vendorId = await vendorShortcodeByName(ctx.db, "Self Merge Charge");
    const { output: keeper } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, orderId: "SELF-1" }),
      ctx.actor,
    );

    // `losers` is `mergeIds` minus `keepId`, so both of these come back before
    // the transaction opens — the keeper must NOT be folded into itself.
    for (const mergeIds of [[keeper.id], []]) {
      const result = await mergePurchases(
        ctx.db,
        { keepId: keeper.id, mergeIds },
        ctx.actor,
      );
      expect(result.id).toBe(keeper.id);
      expect(result.orderId).toBe("SELF-1");
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
      purchaseCreateInput.parse({ vendorId: homeDepot, orderId: "#11325" }),
      ctx.actor,
    );
    const { output: moving } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId: toolNirvana, orderId: "#11325" }),
      ctx.actor,
    );

    await expect(
      updatePurchase(
        ctx.db,
        { id: moving.id, data: { vendorId: homeDepot } },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "PURCHASE_MERGE_ORDER_COLLISION" },
    });
    // Refused, not partially applied.
    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, moving.id)))
        .vendorId,
    ).toBe(toolNirvana);

    // Same collision reached by moving the OTHER half of the key: retyping this
    // charge's order id onto one its own vendor already holds.
    const { output: sibling } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId: homeDepot, orderId: "WN-1" }),
      ctx.actor,
    );
    await expect(
      updatePurchase(
        ctx.db,
        { id: sibling.id, data: { orderId: "#11325" } },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      cause: { reason: "PURCHASE_MERGE_ORDER_COLLISION" },
    });
    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, held.id)))
        .orderId,
    ).toBe("#11325");

    // The check is scoped to LIVE charges and to the key actually changing: a
    // move to a vendor that doesn't hold this order id still goes through.
    const { output: moved } = await updatePurchase(
      ctx.db,
      { id: moving.id, data: { orderId: "TN-99" } },
      ctx.actor,
    );
    expect(moved.orderId).toBe("TN-99");
  });

  it("refuses a soft-deleted vendorId and an unknown charge id", async () => {
    const live = await vendorShortcodeByName(ctx.db, "Still Trading");
    const gone = await vendorShortcodeByName(ctx.db, "Out Of Business");
    const { output: charge } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId: live, orderId: "LIV-1" }),
      ctx.actor,
    );
    // Deleting a vendor with zero charges is allowed, which is exactly how a
    // tombstoned id stays reachable to a direct API caller.
    await deleteVendors(ctx.db, [gone], ctx.actor);

    await expect(
      updatePurchase(
        ctx.db,
        { id: charge.id, data: { vendorId: gone } },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "VENDOR_NOT_FOUND" },
    });
    expect(
      (await getPurchaseByID(ctx.db, await purchaseUuid(ctx.db, charge.id)))
        .vendorId,
    ).toBe(live);

    await expect(
      updatePurchase(
        ctx.db,
        {
          id: unsafePurchaseShortcode("PUR-9999"),
          data: { notes: "no such charge" },
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });
  });
});

describe("purchase repository — deletion cascades", () => {
  const ctx = withTestDb();

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

    const img = await insertAndReturn(ctx.db, image, {
      key: "test-documents/deleted-charge.pdf",
      url: "https://example.com/deleted-charge.pdf",
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

  it("deleting ONE expense leaves the charge intact", async () => {
    const { output: keep } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "kept line",
          cost: 30,
          vendor: "Amazon",
          orderId: "AMZ-KEEP",
        }),
      ),
      ctx.actor,
    );
    const { output: doomed } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "doomed line",
          cost: 70,
          vendor: "Amazon",
          orderId: "AMZ-KEEP",
        }),
      ),
      ctx.actor,
    );
    const chargeId = keep.purchaseId!;
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);
    expect(await getPurchaseExpenses(ctx.db, chargeUuid)).toHaveLength(2);

    await deleteExpenses(ctx.db, [doomed.id], ctx.actor);

    // The charge survives its line's deletion — only that line's money leaves.
    expect(
      (await getPurchaseExpenses(ctx.db, chargeUuid)).map((l) => l.id),
    ).toEqual([keep.id]);
    const charge = await getPurchaseByID(ctx.db, chargeUuid);
    expect(charge.expenseCount).toBe(1);
    expect(charge.expenseTotal).toBe(30);
  });

  it("a charge with no lines left totals 0, not null", async () => {
    const { output: only } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "only line",
          cost: 431.24,
          vendor: "Empty Charge Vendor",
          orderId: "EC-1",
        }),
      ),
      ctx.actor,
    );
    const chargeId = only.purchaseId!;
    await updatePurchase(
      ctx.db,
      { id: chargeId, data: { statedTotal: 431.24 } },
      ctx.actor,
    );

    await deleteExpenses(ctx.db, [only.id], ctx.actor);

    // 0 rather than null so the reconciliation cue reads "stated $431.24, lines
    // $0" instead of going blank.
    const charge = await getPurchaseByID(
      ctx.db,
      await purchaseUuid(ctx.db, chargeId),
    );
    expect(charge.expenseCount).toBe(0);
    expect(charge.expenseTotal).toBe(0);
    expect(reconcilePurchase(charge)).toBe("mismatch");
  });
});

/**
 * The load-bearing guard: attaching charges to expenses must be invisible to
 * every spend number in the app, and `statedTotal` must never reach one.
 */
/**
 * `resolvePurchaseSort` — the three sort keys that are NOT columns on
 * `Purchase`: the joined vendor name and the two correlated rollups. The generic
 * column path can't produce them, so a regression here silently falls back to
 * the default order rather than erroring.
 */
describe("purchase repository — sorting over the joined name and rollups", () => {
  const ctx = withTestDb();

  const seed = async () => {
    const aaa = await vendorShortcodeByName(ctx.db, "AAA Supply");
    const zzz = await vendorShortcodeByName(ctx.db, "ZZZ Supply");
    const { output: small } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId: aaa, orderId: "SORT-SMALL" }),
      ctx.actor,
    );
    const { output: big } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId: zzz, orderId: "SORT-BIG" }),
      ctx.actor,
    );
    // One line at $5 vs. two lines totalling $300 — so count and total rank the
    // two charges the same way, and either could be read for the other.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({ name: "small line", cost: 5, purchaseId: small.id }),
      ),
      ctx.actor,
    );
    for (const cost of [100, 200]) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: `big line ${cost}`,
            cost,
            purchaseId: big.id,
          }),
        ),
        ctx.actor,
      );
    }
    return { small: small.id, big: big.id };
  };

  const idsSortedBy = async (
    orderBy: "vendor" | "expenseCount" | "expenseTotal",
    direction: "asc" | "desc",
  ) =>
    (await purchaseList(ctx.db, {}, [{ orderBy, direction }], page)).data.map(
      (row) => row.id,
    );

  it("sorts by vendor name, expense count, and expense total in both directions", async () => {
    const { small, big } = await seed();

    expect(await idsSortedBy("vendor", "asc")).toEqual([small, big]);
    expect(await idsSortedBy("vendor", "desc")).toEqual([big, small]);

    expect(await idsSortedBy("expenseCount", "desc")).toEqual([big, small]);
    expect(await idsSortedBy("expenseCount", "asc")).toEqual([small, big]);

    expect(await idsSortedBy("expenseTotal", "desc")).toEqual([big, small]);
    expect(await idsSortedBy("expenseTotal", "asc")).toEqual([small, big]);
  });
});

describe("purchase repository — rollups never see a charge", () => {
  const ctx = withTestDb();

  it("every rollup is byte-identical with and without charges, and ignores statedTotal", async () => {
    const { output: project, entityId: projectId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "rollup guard project",
        costEstimate: 500,
      }),
      ctx.actor,
    );

    const seeded = [];
    for (const [name, cost, future, date] of [
      ["guard actual", 100, false, "2024-02-10"],
      ["guard committed", 50, true, "2024-03-05"],
      ["guard credit", -75, false, "2024-03-20"],
      ["guard undated", 25, false, null],
    ] as const) {
      seeded.push(
        (
          await createExpense(
            ctx.db,
            expenseCreateInput.parse(
              makeExpenseInput({
                name,
                cost,
                future,
                date,
                projectId: project.id,
              }),
            ),
            ctx.actor,
          )
        ).output,
      );
    }

    // `byVendor` is held OUT of the byte-identical snapshot, and only that one
    // field. It is the single analytics output that is charge-aware BY DESIGN —
    // it groups spend by the vendor reached through `expense.purchaseId`, so it
    // necessarily goes from empty to populated the moment these lines land on a
    // charge. That is a new GROUPING of the same money, not money moving, which
    // is what this guard is about. It gets its own assertions below: the bucket
    // must equal the summary net exactly, and must ignore `statedTotal` like
    // everything else.
    const snapshot = async () => {
      const { byVendor: _byVendor, ...analytics } = await expenseAnalytics(
        ctx.db,
        {},
      );
      return {
        analytics,
        rollups: Object.fromEntries(await projectRollups(ctx.db, [projectId])),
        dashboard: await projectDashboardSummary(ctx.db, {}),
        portfolio: await projectPortfolioAnalytics(ctx.db, {}),
      };
    };

    const vendorBuckets = async () =>
      (await expenseAnalytics(ctx.db, {})).byVendor;

    const before = await snapshot();
    // Sanity: the baseline is not vacuously empty.
    expect(before.analytics.summary.net).toBe(100);
    expect(before.rollups[projectId]?.spent).toBe(100);
    // No charge yet, so nothing to group by vendor.
    expect(await vendorBuckets()).toEqual([]);

    // Now attach every one of those expenses to a real charge.
    const vendorIdUuid = await findOrCreateVendor(
      ctx.db,
      "Rollup Guard Vendor",
    );
    const vendorId = (await getVendorByID(ctx.db, vendorIdUuid)).id;
    const { output: charge } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId,
        orderId: "RG-1",
        date: "2024-02-10",
      }),
      ctx.actor,
    );
    await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: charge.id, expenseIds: seeded.map((e) => e.id) },
      ctx.actor,
    );
    // The lines really did land on the charge (the `purchaseId` column write —
    // asserted before the charge's own rollup, which is a separate concern).
    expect(
      await getPurchaseExpenses(ctx.db, await purchaseUuid(ctx.db, charge.id)),
    ).toHaveLength(4);

    // A charge is a grouping, not money: not one number may move.
    expect(await snapshot()).toEqual(before);

    // The one thing that DOES change is the vendor grouping — and it regroups
    // exactly the same money. All four lines (including the credit and the
    // undated one) now sit under one vendor, summing to the unchanged net.
    expect(await vendorBuckets()).toEqual([
      {
        vendorId,
        vendorName: "Rollup Guard Vendor",
        actual: 125,
        committed: 50,
        credits: 75,
        net: 100,
        count: 4,
      },
    ]);

    // Now make the charge's OWN stated total disagree wildly with its lines.
    // `statedTotal` is a reconciliation cue and nothing else; if it could ever
    // reach spend, this is where 99999 would show up.
    await updatePurchase(
      ctx.db,
      { id: charge.id, data: { statedTotal: 99999 } },
      ctx.actor,
    );
    expect(await snapshot()).toEqual(before);
    // ...including in the vendor bucket, which is the newest way spend could
    // have picked up a statedTotal by accident.
    expect((await vendorBuckets())[0]?.net).toBe(100);

    // And the vendor's spend is SUM(expense.cost) over the charge's lines —
    // never its statedTotal.
    const vendorRow = await getVendorByID(ctx.db, vendorIdUuid);
    expect(vendorRow.spend).toBe(100);
    expect(vendorRow.spend).not.toBe(99999);

    // Last, the charge's own reconciliation cue: the lines still sum to 100 and
    // the stated total is the 99999 nobody should ever believe.
    const wild = await getPurchaseByID(
      ctx.db,
      await purchaseUuid(ctx.db, charge.id),
    );
    expect(wild.statedTotal).toBe(99999);
    expect(wild.expenseTotal).toBe(100);
    expect(reconcilePurchase(wild)).toBe("mismatch");
  });
});

describe("purchase repository — a soft-deleted charge reads as absent", () => {
  const ctx = withTestDb();

  it("resolves vendor/orderId to null and stops matching the vendorId filter", async () => {
    const { output: line } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "orphaned by a deleted charge",
          cost: 60,
          vendor: "Ghost Vendor",
          orderId: "GHOST-1",
        }),
      ),
      ctx.actor,
    );
    const chargeId = line.purchaseId!;
    const vendorId = line.vendorId!;
    // Resolved while the charge is still live — the direct tombstone below
    // takes it out of `resolveLiveShortcode`'s reach.
    const chargeUuid = await purchaseUuid(ctx.db, chargeId);

    // Tombstone the charge DIRECTLY, leaving the expense's `purchaseId` pointing
    // at it. `deletePurchases` also nulls that column, so this reconstructs the
    // state a future write path could produce — the same white-box approach
    // image.integration.test.ts uses for its cull guards. This is the
    // EXISTS-matches-soft-deleted-rows bug class: a tombstoned charge still
    // satisfies a bare EXISTS.
    await getDb(ctx.db)
      .update(purchase)
      .set({ deletedAt: new Date() })
      .where(eq(purchase.id, chargeUuid));

    const reread = await expenseByShortcode(ctx.db, line.id);
    expect(reread.vendor).toBeNull();
    expect(reread.orderId).toBeNull();
    expect(reread.purchaseId).toBeNull();
    expect(reread.vendorId).toBeNull();
    // The money is untouched.
    expect(reread.cost).toBe(60);

    const filtered = await expenseList(ctx.db, { vendorId }, [], page);
    expect(filtered.data.map((e) => e.id)).not.toContain(line.id);
    expect(filtered.count).toBe(0);

    // Same for the order-id scope — both hop through the charge.
    const byOrder = await expenseList(ctx.db, { orderId: "GHOST-1" }, [], page);
    expect(byOrder.count).toBe(0);
  });

  it("a soft-deleted VENDOR blanks the name while the charge and its money survive", async () => {
    const { output: line } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "vendor tombstoned",
          cost: 15,
          vendor: "Soon Gone Vendor",
          orderId: "SG-1",
        }),
      ),
      ctx.actor,
    );
    const chargeId = line.purchaseId!;
    const vendorId = line.vendorId!;
    // Resolved while the vendor is still live, for the same reason the charge
    // uuid above is — the direct tombstone below is a `deletedAt` write keyed
    // on the uuid column, not the shortcode.
    const vendorIdUuid = await vendorUuid(ctx.db, vendorId);

    // `deleteVendors` refuses while live charges point at the vendor
    // (`VENDOR_HAS_PURCHASES`), and `assertVendorLive` now stops a charge being
    // POINTED at a tombstoned vendor — but neither closes the door completely: a
    // vendor with no charges deletes fine, and any pre-existing row predating the
    // guard can still be in this state. So the read-side fallback stays
    // load-bearing, and this pins it: `vendorName` goes null rather than
    // resolving a deleted row. The tombstone is written directly here because
    // that is now the only way to reach the state.
    await getDb(ctx.db)
      .update(vendor)
      .set({ deletedAt: new Date() })
      .where(eq(vendor.id, vendorIdUuid));

    const charge = await getPurchaseByID(
      ctx.db,
      await purchaseUuid(ctx.db, chargeId),
    );
    expect(charge.vendorName).toBeNull();
    // The charge itself still exists and still points at the (tombstoned) vendor.
    expect(charge.vendorId).toBe(vendorId);

    const reread = await expenseByShortcode(ctx.db, line.id);
    expect(reread.vendor).toBeNull();
    // The charge is still live, so its id and order id still resolve.
    expect(reread.purchaseId).toBe(chargeId);
    expect(reread.orderId).toBe("SG-1");
    // ...and the money is untouched.
    expect(reread.cost).toBe(15);
    expect(charge.expenseTotal).toBe(15);
  });
});

describe("purchase repository — documents", () => {
  const ctx = withTestDb();

  it("attaches a PDF to a charge and reads it back as a document", async () => {
    const vendorId = await vendorShortcodeByName(ctx.db, "Metal Supermarkets");
    const { output: charge } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, orderId: "MS-INVOICE-1" }),
      ctx.actor,
    );
    // `attachFileToEntity`'s `entityId` is the generic (unbranded) uuid every
    // attachable entity shares — not a shortcode.
    const chargeUuid = await purchaseUuid(ctx.db, charge.id);

    const result = await attachFileToEntity(ctx.db, {
      entityType: "purchase",
      entityId: chargeUuid,
      data: Buffer.from("%PDF-1.4 metal invoice").toString("base64"),
      contentType: "application/pdf",
      filename: "metal-invoice.pdf",
    });

    expect(result.kind).toBe("document");
    expect(result.entityType).toBe("purchase");
    expect(result.entityId).toBe(chargeUuid);
    expect(isDocumentFile({ contentType: result.contentType })).toBe(true);

    // The R2 object lands under the documents/ prefix (not images/). NB:
    // `attachFileToEntity` calls `generateDocumentKey(filename)` with NO folder,
    // so there is no purchase-scoped folder segment on this path — the
    // `folder` argument is only supplied by the browser's two-phase
    // `initiateDocumentUpload` flow.
    const [row] = await getDb(ctx.db)
      .select({
        key: image.key,
        contentType: image.contentType,
        status: image.status,
      })
      .from(image)
      .where(eq(image.id, result.imageId));
    expect(row?.key).toContain("/documents/");
    expect(row?.key).toContain("metal-invoice.pdf");
    expect(row?.contentType).toBe("application/pdf");
    expect(row?.status).toBe("UPLOADED");

    // ...and it's filed against the charge through `PurchaseImage`.
    const joins = await getDb(ctx.db).query.purchaseImage.findMany({
      where: eq(purchaseImage.purchaseId, chargeUuid),
    });
    expect(joins).toHaveLength(1);
    expect(joins[0]?.imageId).toBe(result.imageId);
    expect(joins[0]?.deletedAt).toBeNull();
  });

  it("the browser's two-phase document upload files the object under a purchase-scoped folder", async () => {
    const vendorId = await vendorShortcodeByName(ctx.db, "Folder Vendor");
    const { output: charge } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({ vendorId, orderId: "FV-1" }),
      ctx.actor,
    );

    // `folder` is the only way a document key gets a per-entity segment (see
    // `generateDocumentKey`) — `attachFileToEntity` above never passes one, so
    // the purchase-scoped layout lives on THIS path.
    const initiated = await initiateDocumentUpload(ctx.db, {
      filename: "flow-form-invoice.pdf",
      contentType: "application/pdf",
      size: 2048,
      entityType: "PURCHASE",
      folder: charge.id,
    });

    expect(initiated.key).toContain(`/documents/${charge.id}/`);
    expect(initiated.key).toContain("flow-form-invoice.pdf");
    // Still PENDING until the client finishes its PUT and finalizes.
    const pending = await getDb(ctx.db)
      .select({ status: image.status })
      .from(image)
      .where(eq(image.id, initiated.imageId));
    expect(pending[0]?.status).toBe("PENDING");
  });

  it("rejects a document aimed at a charge that does not exist", async () => {
    // Fails BEFORE anything reaches R2, so a bad id can never orphan an object.
    await expect(
      attachFileToEntity(ctx.db, {
        entityType: "purchase",
        entityId: "00000000-0000-0000-0000-000000000000",
        data: Buffer.from("%PDF-1.4").toString("base64"),
        contentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ cause: { reason: "IMAGE_ATTACH_FAILED" } });
  });
});
