import type {
  PurchaseId,
  VendorId,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  unsafePurchaseId,
  unsafeVendorId,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { and, eq, inArray, sql } from "drizzle-orm";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  auditLog,
  expense,
  image,
  purchase,
  purchaseImage,
  vendor,
} from "~/server/db/schema";
import { getDb, insertAndReturn, notDeleted } from "./database-helpers";
import { createExpense, deleteExpenses } from "./expense";
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
  createVendor,
  deleteVendors,
  findOrCreateVendor,
  getVendorByID,
  mergeVendors,
  previewMergeVendors,
  updateVendor,
  vendorList,
  vendorOptions,
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

  it("is idempotent on the vendor name and trims before matching", async () => {
    const first = await findOrCreateVendor(ctx.db, "Tool Nirvana");
    const again = await findOrCreateVendor(ctx.db, "Tool Nirvana");
    // Whitespace is trimmed on the way in, so a padded name resolves to the
    // same row rather than creating a near-duplicate the roster can't dedupe.
    const padded = await findOrCreateVendor(ctx.db, "  Tool Nirvana  ");

    expect(again).toBe(first);
    expect(padded).toBe(first);

    const { count } = await vendorList(ctx.db, {}, [], page);
    expect(count).toBe(1);
  });

  it("matches names EXACTLY, so a case variant is a separate vendor", async () => {
    // Deliberately case-SENSITIVE: folding case here would silently merge a
    // genuine "3M" / "3m" distinction on first sight, and near-duplicates are a
    // merge decision (a user action), not a write-path guess.
    const upper = await findOrCreateVendor(ctx.db, "3M");
    const lower = await findOrCreateVendor(ctx.db, "3m");

    expect(lower).not.toBe(upper);
    expect((await vendorList(ctx.db, {}, [], page)).count).toBe(2);
  });

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

  it("creates a vendor with no charges and no spend", async () => {
    const id = await findOrCreateVendor(ctx.db, "Brand New Vendor");
    const row = await getVendorByID(ctx.db, id);

    expect(row.name).toBe("Brand New Vendor");
    expect(row.purchaseCount).toBe(0);
    expect(row.spend).toBe(0);
  });
});

describe("vendor repository — roster CRUD and list filters", () => {
  const ctx = withTestDb();

  it("creates, reads back, and updates the roster fields", async () => {
    const { output: created } = await createVendor(
      ctx.db,
      vendorCreateInput.parse({
        name: "Masseria Calderisi",
        website: "https://example.com/masseria",
      }),
      ctx.actor,
    );
    expect(created.website).toBe("https://example.com/masseria");
    expect(created.notes).toBeNull();

    const { output: updated } = await updateVendor(
      ctx.db,
      {
        id: created.id,
        data: { name: "  Masseria Calderisi Srl  ", notes: "COI on file" },
      },
      ctx.actor,
    );
    expect(updated.name).toBe("Masseria Calderisi Srl");
    expect(updated.notes).toBe("COI on file");
    // Unwritten fields survive a partial update.
    expect(updated.website).toBe("https://example.com/masseria");
  });

  it("filters by name search, case-insensitively", async () => {
    await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Amazon" }),
      ctx.actor,
    );
    await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Amazon Business" }),
      ctx.actor,
    );
    await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Flow Form Plumbing" }),
      ctx.actor,
    );

    // `search` is the roster's only filter — a substring match on the NAME.
    const searched = await vendorList(ctx.db, { search: "amazon" }, [], page);
    expect(searched.data.map((v) => v.name).sort()).toEqual([
      "Amazon",
      "Amazon Business",
    ]);

    const plumbing = await vendorList(ctx.db, { search: "plumb" }, [], page);
    expect(plumbing.data.map((v) => v.name)).toEqual(["Flow Form Plumbing"]);
  });

  it("refuses to update a vendor that does not exist or has been deleted", async () => {
    const { output: gone } = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Shuttered Supply" }),
      ctx.actor,
    );
    await deleteVendors(ctx.db, [gone.id], ctx.actor);

    // A tombstoned row still satisfies the id, so the update has to check
    // `deletedAt` itself — otherwise a rename would silently resurrect it into
    // every name-based lookup.
    await expect(
      updateVendor(
        ctx.db,
        { id: gone.id, data: { name: "Reopened" } },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "VENDOR_NOT_FOUND" },
    });

    await expect(
      updateVendor(
        ctx.db,
        {
          // Well-formed but never minted in this test run — same "-2222"
          // placeholder convention as shortcode.integration.test.ts.
          id: unsafeVendorShortcode("VEN-2222"),
          data: { name: "Never Existed" },
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "VENDOR_NOT_FOUND" },
    });
  });

  /**
   * `resolveVendorSort` — neither rollup is a column on `Vendor`, so the generic
   * column path can't order by them; a regression falls back to the default
   * order instead of erroring.
   */
  it("sorts by the purchaseCount and spend rollups in both directions", async () => {
    const quietId = await findOrCreateVendor(ctx.db, "One Charge Vendor");
    const busyId = await findOrCreateVendor(ctx.db, "Two Charge Vendor");
    // `findOrCreateVendor` still returns the internal uuid; the purchase input
    // and the vendorList id comparisons below speak the public shortcode.
    const quiet = (await getVendorByID(ctx.db, quietId)).id;
    const busy = (await getVendorByID(ctx.db, busyId)).id;

    const { output: quietCharge } = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2024-01-15",
        vendorId: quiet,
        orderId: "Q-1",
      }),
      ctx.actor,
    );
    for (const orderId of ["B-1", "B-2"]) {
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: busy,
          orderId,
        }),
        ctx.actor,
      );
    }
    // Spend ranks the OPPOSITE way to charge count — one big charge vs. two
    // empty ones — so neither sort key can be read for the other.
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "the only spend",
          cost: 500,
          purchaseId: quietCharge.id,
        }),
      ),
      ctx.actor,
    );

    const idsBy = async (
      orderBy: "purchaseCount" | "spend",
      direction: "asc" | "desc",
    ) =>
      (await vendorList(ctx.db, {}, [{ orderBy, direction }], page)).data.map(
        (v) => v.id,
      );

    expect(await idsBy("purchaseCount", "desc")).toEqual([busy, quiet]);
    expect(await idsBy("purchaseCount", "asc")).toEqual([quiet, busy]);
    expect(await idsBy("spend", "desc")).toEqual([quiet, busy]);
    expect(await idsBy("spend", "asc")).toEqual([busy, quiet]);
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

  it("drops a soft-deleted expense, and a soft-deleted charge's expenses, from spend", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Deleted Parts Vendor");

    const keptCharge = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: "KEPT-1",
      date: "2024-01-15",
    });
    const doomedCharge = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: "DOOMED-1",
      date: "2024-01-15",
    });
    // `findOrCreatePurchase` (the import hot path) still returns the internal
    // uuid; the expense input and `deletePurchases` speak the public shortcode.
    const keptChargeCode = (await getPurchaseByID(ctx.db, keptCharge)).id;
    const doomedChargeCode = (await getPurchaseByID(ctx.db, doomedCharge)).id;

    const line = (name: string, cost: number, purchaseId: string) =>
      expenseCreateInput.parse({
        date: "2024-01-15",
        name,
        trade: "other",
        costType: "materials",
        cost,
        purchaseId,
      });

    await createExpense(
      ctx.db,
      line("kept line", 40, keptChargeCode),
      ctx.actor,
    );
    const { output: doomedLine } = await createExpense(
      ctx.db,
      line("soon-deleted line", 10, keptChargeCode),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      line("line under doomed charge", 500, doomedChargeCode),
      ctx.actor,
    );

    expect((await getVendorByID(ctx.db, vendorId)).spend).toBe(550);
    expect((await getVendorByID(ctx.db, vendorId)).purchaseCount).toBe(2);

    await deleteExpenses(ctx.db, [doomedLine.id], ctx.actor);
    expect((await getVendorByID(ctx.db, vendorId)).spend).toBe(540);

    // Both levels of the rollup guard `deletedAt`: deleting the CHARGE must
    // drop its lines from the vendor's spend too. (`deletePurchases` also nulls
    // `expense.purchaseId`, which is the same outcome from the other side — an
    // expense with no charge belongs to no vendor.)
    await deletePurchases(ctx.db, [doomedChargeCode], ctx.actor);
    const after = await getVendorByID(ctx.db, vendorId);
    expect(after.spend).toBe(40);
    expect(after.purchaseCount).toBe(1);
  });
});

describe("vendor repository — vendorOptions picklist", () => {
  const ctx = withTestDb();

  it("returns {id, name, count} over LIVE charges, keeps a zero-charge vendor, and hides deleted vendors", async () => {
    const busyId = await findOrCreateVendor(ctx.db, "Busy Vendor");
    const quietId = await findOrCreateVendor(ctx.db, "Quiet Vendor");
    // A vendor can exist before any money went there — the whole point of a
    // roster table (its free-text `GROUP BY` predecessor could never list one).
    const emptyId = await findOrCreateVendor(ctx.db, "Aspirational Vendor");
    const doomedId = await findOrCreateVendor(ctx.db, "Deleted Vendor");

    await findOrCreatePurchase(ctx.db, {
      vendorId: busyId,
      orderId: "B-1",
      date: "2024-01-15",
    });
    await findOrCreatePurchase(ctx.db, {
      vendorId: busyId,
      orderId: "B-2",
      date: "2024-01-15",
    });
    const deletedCharge = await findOrCreatePurchase(ctx.db, {
      vendorId: busyId,
      orderId: "B-3",
      date: "2024-01-15",
    });
    await findOrCreatePurchase(ctx.db, {
      vendorId: quietId,
      orderId: "Q-1",
      date: "2024-01-15",
    });

    await deletePurchases(
      ctx.db,
      [(await getPurchaseByID(ctx.db, deletedCharge)).id],
      ctx.actor,
    );
    // Resolved to its shortcode BEFORE the delete — `deleteVendors` speaks
    // shortcodes, and the code stays a valid (tombstoned) reference after.
    const doomed = (await getVendorByID(ctx.db, doomedId)).id;
    await deleteVendors(ctx.db, [doomed], ctx.actor);

    const busy = (await getVendorByID(ctx.db, busyId)).id;
    const quiet = (await getVendorByID(ctx.db, quietId)).id;
    const empty = (await getVendorByID(ctx.db, emptyId)).id;

    const options = await vendorOptions(ctx.db);

    // Ranked by live-charge count desc, then name asc.
    expect(options).toEqual([
      { id: busy, name: "Busy Vendor", count: 2 },
      { id: quiet, name: "Quiet Vendor", count: 1 },
      { id: empty, name: "Aspirational Vendor", count: 0 },
    ]);
    expect(options.map((o) => o.id)).not.toContain(doomed);
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
      cause: { reason: "VENDOR_HAS_PURCHASES" },
    });

    await deletePurchases(
      ctx.db,
      [(await getPurchaseByID(ctx.db, charge)).id],
      ctx.actor,
    );
    await deleteVendors(ctx.db, [vendorShortcode], ctx.actor);

    await expect(getVendorByID(ctx.db, vendorId)).rejects.toMatchObject({
      cause: { reason: "VENDOR_NOT_FOUND" },
    });
    expect((await vendorList(ctx.db, {}, [], page)).count).toBe(0);
  });

  it("reaps an exclusive logo but preserves an image shared by another vendor", async () => {
    const [logo] = await getDb(ctx.db)
      .insert(image)
      .values({
        url: "https://example.com/shared-vendor-logo.png",
        key: "shared-vendor-logo.png",
        filename: "shared-vendor-logo.png",
        size: 1,
        contentType: "image/png",
      })
      .returning({ id: image.id, key: image.key });
    const first = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Shared Logo A" }),
      ctx.actor,
    );
    const second = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Shared Logo B" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(vendor)
      .set({ logoImageId: logo!.id })
      .where(inArray(vendor.id, [first.entityId, second.entityId]));

    expect(await deleteVendors(ctx.db, [first.output.id], ctx.actor)).toEqual({
      detachedImageKeys: [],
    });
    expect(
      await getDb(ctx.db).query.image.findFirst({
        where: eq(image.id, logo!.id),
        columns: { deletedAt: true },
      }),
    ).toMatchObject({ deletedAt: null });

    expect(await deleteVendors(ctx.db, [second.output.id], ctx.actor)).toEqual({
      detachedImageKeys: [logo!.key],
    });
    expect(
      await getDb(ctx.db).query.image.findFirst({
        where: eq(image.id, logo!.id),
        columns: { id: true },
      }),
    ).toBeUndefined();
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

  /** The raw charge row, deleted ones included — `getPurchaseByID` hides those. */
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
  const vendorUuid = async (shortcode: VendorShortcode): Promise<VendorId> => {
    const id = await resolveLiveShortcode(ctx.db, shortcode, "vendor");
    if (!id) throw new Error(`vendor not found: ${shortcode}`);
    return unsafeVendorId(id);
  };
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

  /** An UPLOADED image + its `PurchaseImage` join row, filed against `id`. */
  const attachDocumentRow = async (purchaseId: PurchaseId, label: string) => {
    const img = await insertAndReturn(ctx.db, image, {
      key: `test-documents/${label}.pdf`,
      url: `https://example.com/${label}.pdf`,
      filename: `${label}.pdf`,
      contentType: "application/pdf",
      size: 100,
      status: "UPLOADED",
    });
    const join = await insertAndReturn(ctx.db, purchaseImage, {
      purchaseId,
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
    return unsafePurchaseId(id);
  };

  it("re-points the losers' charges, soft-deletes the losers, and unions the keeper's rollups", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "B&H Photo");
    const loser = await findOrCreateVendor(ctx.db, "B&H");

    const keeperCharge = await charge(keeper, "KEEP-1");
    const loserOrdered = await charge(loser, "LOSE-1");
    // An order-less charge on the loser: nothing to collide with, so it just
    // re-points like any other row.
    const loserCashRun = await charge(loser, null);

    await addLine("keeper line", 100, keeperCharge);
    await addLine("loser line", 40, loserOrdered);
    await addLine("cash run line", 10, loserCashRun);

    const moneyBefore = await liveExpenseTotal();

    const merged = await mergeVendors(
      ctx.db,
      { keepId: await vendorCode(keeper), mergeIds: [await vendorCode(loser)] },
      ctx.actor,
    );

    expect(merged.id).toBe(await vendorCode(keeper));
    // Union of both sides: 3 live charges, 150 of live spend.
    expect(merged.purchaseCount).toBe(3);
    expect(merged.spend).toBe(150);

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
      cause: { reason: "VENDOR_NOT_FOUND" },
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

    // Does not throw — the fold happens BEFORE the bulk re-point.
    const merged = await mergeVendors(
      ctx.db,
      { keepId: await vendorCode(keeper), mergeIds: [await vendorCode(loser)] },
      ctx.actor,
    );

    // One order, one charge: the two collapsed into a single live row.
    expect(merged.purchaseCount).toBe(1);
    expect(merged.spend).toBe(100);

    const lines = await getPurchaseExpenses(ctx.db, survivor);
    expect(lines.map((l) => l.name).sort()).toEqual([
      "folded line",
      "survivor line",
    ]);

    // Documents follow their charge: a live join row against the survivor for
    // BOTH images, and the folded charge's own join row tombstoned.
    const survivorDocs = await getDb(ctx.db).query.purchaseImage.findMany({
      where: and(
        eq(purchaseImage.purchaseId, survivor),
        notDeleted(purchaseImage),
      ),
    });
    expect(survivorDocs.map((d) => d.imageId).sort()).toEqual(
      [survivorDoc.imageId, deadDoc.imageId].sort(),
    );
    const [oldJoin] = await getDb(ctx.db)
      .select({ deletedAt: purchaseImage.deletedAt })
      .from(purchaseImage)
      .where(eq(purchaseImage.id, deadDoc.joinId));
    expect(oldJoin?.deletedAt).not.toBeNull();

    expect((await chargeRow(dead))?.deletedAt).not.toBeNull();
    await expect(getPurchaseByID(ctx.db, dead)).rejects.toMatchObject({
      cause: { reason: "PURCHASE_NOT_FOUND" },
    });

    // The folded charge's money moved to the survivor, it did not disappear
    // with the charge.
    expect(await liveExpenseTotal()).toBe(moneyBefore);
  });

  it("previews settlement movement caused by a transitive purchase fold", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "Preview Amazon");
    const loser = await findOrCreateVendor(ctx.db, "Preview Amazon.com");
    await charge(keeper, "PREVIEW-FOLD");
    const dead = await charge(loser, "PREVIEW-FOLD");
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Preview Fold Card",
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
        last4: "4242",
      },
      provisional: false,
      sourceAliases: [],
      notes: null,
    });
    await insertSettlementTransaction(ctx.db, {
      accountId: account.id,
      purchaseId: dead,
      kind: "purchase",
      status: "posted",
      amount: 25,
      transactionDate: "2024-02-01",
      postedDate: "2024-02-02",
      merchant: "Preview Amazon",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [],
      notes: null,
    });

    const preview = await previewMergeVendors(ctx.db, {
      keepId: keeper,
      mergeIds: [loser],
    });
    expect(
      preview.sideEffects.find(
        (item) => item.label === "financial transactions moved by a fold",
      ),
    ).toMatchObject({
      total: 1,
      byTargetId: { [loser]: 1 },
    });
  });

  it("gives the survivor slot to the KEEPER's charge when it holds the order id", async () => {
    // Ids the user can already see stay stable: the keeper's charge is the one
    // that survives, never the loser's.
    const keeper = await findOrCreateVendor(ctx.db, "Home Depot");
    const loser = await findOrCreateVendor(ctx.db, "The Home Depot");

    const keeperCharge = await charge(keeper, "WN63446464");
    const loserCharge = await charge(loser, "WN63446464");

    await mergeVendors(
      ctx.db,
      { keepId: await vendorCode(keeper), mergeIds: [await vendorCode(loser)] },
      ctx.actor,
    );

    expect((await chargeRow(keeperCharge))?.deletedAt).toBeNull();
    expect((await chargeRow(loserCharge))?.deletedAt).not.toBeNull();
  });

  it("keeps a loser's charge when only the loser holds that order id, and re-points it", async () => {
    // The reverse construction: with no competitor there is no fold at all, so
    // the loser's charge survives with its own id under the keeper.
    const keeper = await findOrCreateVendor(ctx.db, "Metal Supermarkets");
    const loser = await findOrCreateVendor(ctx.db, "Metal Supermarket");

    const keeperCharge = await charge(keeper, "MS-OTHER");
    const loserCharge = await charge(loser, "MS-ONLY");
    await addLine("loser only line", 55, loserCharge);

    const merged = await mergeVendors(
      ctx.db,
      { keepId: await vendorCode(keeper), mergeIds: [await vendorCode(loser)] },
      ctx.actor,
    );

    const row = await chargeRow(loserCharge);
    expect(row?.deletedAt).toBeNull();
    expect(row?.vendorId).toBe(keeper);
    expect(row?.orderId).toBe("MS-ONLY");
    expect((await chargeRow(keeperCharge))?.deletedAt).toBeNull();
    expect(merged.purchaseCount).toBe(2);
    expect(merged.spend).toBe(55);
  });

  it("resolves a collision between TWO LOSERS, because grouping is over the whole merge set", async () => {
    // Pairwise keeper-vs-loser grouping would leave these two colliding with
    // each other and the bulk re-point would raise a unique violation. Which of
    // the two wins the survivor slot is unspecified (neither belongs to the
    // keeper), so assert the shape, not the id.
    const keeper = await findOrCreateVendor(ctx.db, "Tool Nirvana");
    const loserA = await findOrCreateVendor(ctx.db, "ToolNirvana");
    const loserB = await findOrCreateVendor(ctx.db, "tool nirvana");

    const keeperCharge = await charge(keeper, "TN-UNIQUE");
    const chargeA = await charge(loserA, "#11325");
    const chargeB = await charge(loserB, "#11325");

    await addLine("keeper line", 5, keeperCharge);
    await addLine("A line", 20, chargeA);
    await addLine("B line", 30, chargeB);

    const moneyBefore = await liveExpenseTotal();

    const merged = await mergeVendors(
      ctx.db,
      {
        keepId: await vendorCode(keeper),
        mergeIds: [await vendorCode(loserA), await vendorCode(loserB)],
      },
      ctx.actor,
    );

    const rowA = await chargeRow(chargeA);
    const rowB = await chargeRow(chargeB);
    const survivorId = rowA?.deletedAt === null ? chargeA : chargeB;
    const deadId = survivorId === chargeA ? chargeB : chargeA;

    // Exactly one of the colliding pair is live, and it belongs to the keeper.
    expect(
      [rowA?.deletedAt, rowB?.deletedAt].filter((d) => d === null),
    ).toHaveLength(1);
    expect((await chargeRow(survivorId))?.vendorId).toBe(keeper);
    expect((await chargeRow(deadId))?.deletedAt).not.toBeNull();

    // Both losers' lines ended up on the one surviving charge.
    expect(
      (await getPurchaseExpenses(ctx.db, survivorId))
        .map((l) => l.cost)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([20, 30]);

    expect(merged.purchaseCount).toBe(2);
    expect(merged.spend).toBe(55);
    expect(await liveExpenseTotal()).toBe(moneyBefore);
  });

  it("never folds order-less charges — they all re-point and coexist", async () => {
    // `(vendorId, null)` isn't covered by the partial-unique index, and two
    // undated cash runs to one vendor are two real charges. Folding them would
    // silently merge unrelated spend.
    const keeper = await findOrCreateVendor(ctx.db, "Cash Vendor");
    const loser = await findOrCreateVendor(ctx.db, "cash vendor");

    const keeperCash = await charge(keeper, null);
    const loserCashA = await charge(loser, null);
    const loserCashB = await charge(loser, null);

    await addLine("keeper cash", 11, keeperCash);
    await addLine("loser cash A", 22, loserCashA);
    await addLine("loser cash B", 33, loserCashB);

    const merged = await mergeVendors(
      ctx.db,
      { keepId: await vendorCode(keeper), mergeIds: [await vendorCode(loser)] },
      ctx.actor,
    );

    for (const id of [keeperCash, loserCashA, loserCashB]) {
      const row = await chargeRow(id);
      expect(row?.deletedAt).toBeNull();
      expect(row?.vendorId).toBe(keeper);
    }
    expect(merged.purchaseCount).toBe(3);
    expect(merged.spend).toBe(66);
  });

  it("carries website/notes the keeper LACKS and never overwrites one it has", async () => {
    // The real first case: `B&H` held the website with 1 charge, `B&H Photo` had
    // 4 charges and no website. The better-populated duplicate is rarely the one
    // with more history, so the keeper fills its gaps from the losers.
    const { output: keeper } = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "B&H Photo", notes: "keeper notes" }),
      ctx.actor,
    );
    const { output: loser } = await createVendor(
      ctx.db,
      vendorCreateInput.parse({
        name: "B&H",
        website: "https://bhphotovideo.example",
        notes: "loser notes",
      }),
      ctx.actor,
    );

    const merged = await mergeVendors(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    expect(merged.website).toBe("https://bhphotovideo.example");
    // The keeper already had notes, so the loser's are discarded rather than
    // clobbering a value a human wrote.
    expect(merged.notes).toBe("keeper notes");

    const [entry] = await auditRows(
      "vendor",
      await vendorUuid(keeper.id),
      "update",
    );
    expect(entry?.changes?.carriedOver).toEqual({
      from: null,
      to: { website: "https://bhphotovideo.example" },
    });
  });

  it("carries the folded charge's statedTotal when the survivor has none", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "Stated Keeper");
    const loser = await findOrCreateVendor(ctx.db, "stated keeper");

    const survivor = await charge(keeper, "ST-1", null);
    const dead = await charge(loser, "ST-1", 249.99);

    await mergeVendors(
      ctx.db,
      { keepId: await vendorCode(keeper), mergeIds: [await vendorCode(loser)] },
      ctx.actor,
    );

    // `statedTotal` is the reconciliation cue the `Purchase` table exists to
    // hold; dropping it in the fold would destroy it silently.
    expect((await chargeRow(survivor))?.statedTotal).toBe(249.99);
    expect((await chargeRow(dead))?.deletedAt).not.toBeNull();
  });

  it("keeps the survivor's conflicting statedTotal and names the discarded one in the audit row", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "Conflict Keeper");
    const loser = await findOrCreateVendor(ctx.db, "conflict keeper");

    const survivor = await charge(keeper, "CF-1", 100);
    const dead = await charge(loser, "CF-1", 175.5);

    await mergeVendors(
      ctx.db,
      { keepId: await vendorCode(keeper), mergeIds: [await vendorCode(loser)] },
      ctx.actor,
    );

    // Two different stated totals is a real conflict: the survivor's stands, and
    // the discarded value is recorded rather than vanishing.
    expect((await chargeRow(survivor))?.statedTotal).toBe(100);
    const [entry] = await auditRows("purchase", survivor, "update");
    expect(entry?.changes?.foldedIn).toEqual({ from: null, to: dead });
    expect(entry?.changes?.discardedStatedTotal).toEqual({
      from: 175.5,
      to: 100,
    });
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

    // The folded charge is tombstoned in the log, the survivor names what it
    // absorbed, and the losing vendors are logged as deleted.
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

  it("filters keepId out of mergeIds, so a self-merge is a no-op", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "Self Merge Vendor");
    const keeperCharge = await charge(keeper, "SELF-1");
    await addLine("self line", 77, keeperCharge);
    const keeperCode = await vendorCode(keeper);

    const selfOnly = await mergeVendors(
      ctx.db,
      { keepId: keeperCode, mergeIds: [keeperCode] },
      ctx.actor,
    );
    const emptySet = await mergeVendors(
      ctx.db,
      { keepId: keeperCode, mergeIds: [] },
      ctx.actor,
    );

    // Not self-destruction: the keeper is returned untouched and its charge is
    // neither folded nor deleted.
    for (const result of [selfOnly, emptySet]) {
      expect(result.id).toBe(keeperCode);
      expect(result.purchaseCount).toBe(1);
      expect(result.spend).toBe(77);
    }
    expect((await chargeRow(keeperCharge))?.deletedAt).toBeNull();
    // An empty effective loser set returns early, before the transaction — so
    // there is no merge audit row at all.
    expect(await auditRows("vendor", keeper, "update")).toHaveLength(0);
  });

  it("refuses to merge an already-deleted vendor", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "Live Keeper");
    const gone = await findOrCreateVendor(ctx.db, "Already Gone");
    // Resolved to its shortcode BEFORE the delete — `deleteVendors` speaks
    // shortcodes, and the code stays a valid (tombstoned) reference after.
    const goneCode = await vendorCode(gone);
    await deleteVendors(ctx.db, [goneCode], ctx.actor);

    const keeperCharge = await charge(keeper, "LK-1");
    await addLine("keeper line", 9, keeperCharge);

    // `lockAndValidateForDelete` covers the whole merge set, so a soft-deleted
    // id fails the lock rather than being silently skipped: merging a tombstone
    // would re-run its side effects (and re-log its delete) against rows that
    // already moved.
    await expect(
      mergeVendors(
        ctx.db,
        { keepId: await vendorCode(keeper), mergeIds: [goneCode] },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ cause: { reason: "VENDOR_NOT_FOUND" } });

    // The transaction rolled back: the keeper is untouched.
    const after = await getVendorByID(ctx.db, keeper);
    expect(after.purchaseCount).toBe(1);
    expect(after.spend).toBe(9);
    expect(await auditRows("vendor", keeper, "update")).toHaveLength(0);
  });
});
