import { expenseCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { vendor } from "~/server/db/schema";
import { getDb } from "./database-helpers";
import { createExpense, deleteExpenses } from "./expense";
import {
  createPurchase,
  deletePurchases,
  findOrCreatePurchase,
} from "./purchase";
import {
  createVendor,
  deleteVendors,
  findOrCreateVendor,
  getVendorByID,
  updateVendor,
  vendorList,
  vendorOptions,
} from "./vendor";

/**
 * `Vendor` is a thin roster: `name` (partial-unique where live), `kind`,
 * `website`, `notes`. No money is stored here — `vendorOut.spend` is a
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
    expect(row.kind).toBeNull();
    expect(row.purchaseCount).toBe(0);
    expect(row.spend).toBe(0);
  });
});

describe("vendor repository — roster CRUD and list filters", () => {
  const ctx = withTestDb();

  it("creates, reads back, and updates the roster fields", async () => {
    const created = await createVendor(
      ctx.db,
      vendorCreateInput.parse({
        name: "Masseria Calderisi",
        kind: "contractor",
        website: "https://example.com/masseria",
      }),
      ctx.actor,
    );
    expect(created.kind).toBe("contractor");
    expect(created.website).toBe("https://example.com/masseria");
    expect(created.notes).toBeNull();

    const updated = await updateVendor(
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
    expect(updated.kind).toBe("contractor");
    expect(updated.website).toBe("https://example.com/masseria");
  });

  it("filters by kind and by name search", async () => {
    await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Amazon", kind: "retailer" }),
      ctx.actor,
    );
    await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Amazon Business", kind: "retailer" }),
      ctx.actor,
    );
    await createVendor(
      ctx.db,
      vendorCreateInput.parse({
        name: "Flow Form Plumbing",
        kind: "contractor",
      }),
      ctx.actor,
    );

    const contractors = await vendorList(
      ctx.db,
      { kind: "contractor" },
      [],
      page,
    );
    expect(contractors.data.map((v) => v.name)).toEqual(["Flow Form Plumbing"]);

    const searched = await vendorList(ctx.db, { search: "amazon" }, [], page);
    expect(searched.data.map((v) => v.name).sort()).toEqual([
      "Amazon",
      "Amazon Business",
    ]);
  });
});

describe("vendor repository — spend rollup", () => {
  const ctx = withTestDb();

  it("spend is SUM(expense.cost), never the charge's statedTotal", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Spend Rollup Vendor");
    const charge = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId,
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
    });
    const doomedCharge = await findOrCreatePurchase(ctx.db, {
      vendorId,
      orderId: "DOOMED-1",
    });

    const line = (name: string, cost: number, purchaseId: string) =>
      expenseCreateInput.parse({
        name,
        trade: "other",
        costType: "materials",
        cost,
        purchaseId,
      });

    await createExpense(ctx.db, line("kept line", 40, keptCharge), ctx.actor);
    const doomedLine = await createExpense(
      ctx.db,
      line("soon-deleted line", 10, keptCharge),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      line("line under doomed charge", 500, doomedCharge),
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
    await deletePurchases(ctx.db, [doomedCharge], ctx.actor);
    const after = await getVendorByID(ctx.db, vendorId);
    expect(after.spend).toBe(40);
    expect(after.purchaseCount).toBe(1);
  });
});

describe("vendor repository — vendorOptions picklist", () => {
  const ctx = withTestDb();

  it("returns {id, name, count} over LIVE charges, keeps a zero-charge vendor, and hides deleted vendors", async () => {
    const busy = await findOrCreateVendor(ctx.db, "Busy Vendor");
    const quiet = await findOrCreateVendor(ctx.db, "Quiet Vendor");
    // A vendor can exist before any money went there — the whole point of a
    // roster table (its free-text `GROUP BY` predecessor could never list one).
    const empty = await findOrCreateVendor(ctx.db, "Aspirational Vendor");
    const doomed = await findOrCreateVendor(ctx.db, "Deleted Vendor");

    await findOrCreatePurchase(ctx.db, { vendorId: busy, orderId: "B-1" });
    await findOrCreatePurchase(ctx.db, { vendorId: busy, orderId: "B-2" });
    const deletedCharge = await findOrCreatePurchase(ctx.db, {
      vendorId: busy,
      orderId: "B-3",
    });
    await findOrCreatePurchase(ctx.db, { vendorId: quiet, orderId: "Q-1" });

    await deletePurchases(ctx.db, [deletedCharge], ctx.actor);
    await deleteVendors(ctx.db, [doomed], ctx.actor);

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
    });

    // Dropping the vendor would leave that charge resolving `vendorName` to
    // null, which reads as "no vendor recorded" and is a lie. The re-point path
    // is `mergePurchases`, not a cascade.
    await expect(
      deleteVendors(ctx.db, [vendorId], ctx.actor),
    ).rejects.toMatchObject({
      cause: { reason: "VENDOR_HAS_PURCHASES" },
    });

    await deletePurchases(ctx.db, [charge], ctx.actor);
    await deleteVendors(ctx.db, [vendorId], ctx.actor);

    await expect(getVendorByID(ctx.db, vendorId)).rejects.toMatchObject({
      cause: { reason: "VENDOR_NOT_FOUND" },
    });
    expect((await vendorList(ctx.db, {}, [], page)).count).toBe(0);
  });
});
