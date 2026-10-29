import type {
  PurchaseId,
  VendorId,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  getDb,
  insertAndReturn,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  auditLog,
  entityAttachment,
  expense,
  externalSource,
  purchase,
  product,
  vendor,
} from "~/server/db/schema";
import {
  updateProduct,
  deleteProducts,
} from "~/server/domains/product/repo/crud";
import {
  deletePurchases,
  findOrCreatePurchase,
  readPurchaseById,
  getPurchaseExpenses,
} from "~/server/domains/purchase/repo/purchase";
import { loadRelatedPreviews } from "~/server/generic/entity-links/repo/related-view";
import { withListGroupBy } from "~/server/generic/list/repo/list";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
  makeExpenseInput,
} from "~/server/testing/repo.fixtures";

import {
  deleteVendors,
  findOrCreateVendor,
  readVendorById,
  getVendorCoverage,
  mergeVendors,
  vendorScaffold,
  updateVendor,
} from "./vendor";

/**
 * `Vendor` is a thin roster: `name` (partial-unique where live), `website`,
 * `notes`. No money is stored here — `vendorOut.spend` is a
 * correlated rollup over the vendor's live charges' live expenses, and the tests
 * below pin that it can never come from `purchase.statedTotal`.
 */

const page = { pageIndex: 0, pageSize: 50 };

describe("Brand lifecycle serialization", () => {
  const ctx = withTestDb();
  it("finishes an edit resubmitting its Brand before a concurrent Vendor merge", async () => {
    const keeper = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic kept Brand",
    });
    const donor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic merged Brand",
    });
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic Brand lock item",
        brandId: donor.id,
      }),
      ctx.actor,
    );
    let updating: Promise<unknown> | undefined;
    let merging: Promise<unknown> | undefined;
    try {
      await withTransactionDatabase(ctx.db, async (holder) => {
        await getDb(holder)
          .select({ id: product.id })
          .from(product)
          .where(eq(product.id, item.entityId))
          .for("update");
        const holderPid = (
          await getDb(holder).execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          )
        ).rows[0]?.pid;
        if (!holderPid)
          throw new Error("Synthetic Product lock holder is missing");
        updating = updateProduct(
          ctx.db,
          item.entityId,
          {
            name: "Synthetic edited Brand lock item",
            brandId: donor.shortcode,
          },
          ctx.actor,
        ).catch((error: unknown) => error);
        let updaterPid: number | undefined;
        await expect
          .poll(
            async () => {
              updaterPid = (
                await getDb(ctx.db).execute<{ pid: number }>(sql`
            SELECT pid FROM pg_stat_activity WHERE datname=current_database()
              AND ${holderPid}::int = ANY(pg_blocking_pids(pid)) LIMIT 1`)
              ).rows[0]?.pid;
              return updaterPid !== undefined;
            },
            { timeout: 5_000, interval: 20 },
          )
          .toBe(true);
        merging = mergeVendors(
          ctx.db,
          { keepId: keeper.shortcode, mergeIds: [donor.shortcode] },
          ctx.actor,
        ).catch((error: unknown) => error);
        // With Vendor-before-Product ordering, merge waits on the editing transaction.
        // Reversed ordering instead leaves both writers waiting on the held Product.
        await expect
          .poll(
            async () =>
              (
                await getDb(ctx.db).execute<{ waiting: boolean }>(sql`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND ${updaterPid}::int = ANY(pg_blocking_pids(pid))) AS waiting`)
              ).rows[0]?.waiting,
            { timeout: 5_000, interval: 20 },
          )
          .toBe(true);
      });
    } finally {
      await Promise.all([updating, merging]);
    }
    expect(await updating).not.toBeInstanceOf(Error);
    expect(await merging).not.toBeInstanceOf(Error);
    expect(
      await getDb(ctx.db)
        .select({ name: product.name, brandId: product.brandId })
        .from(product)
        .where(eq(product.id, item.entityId)),
    ).toEqual([
      { name: "Synthetic edited Brand lock item", brandId: keeper.id },
    ]);
  });
});

describe("vendor repository — findOrCreateVendor", () => {
  const ctx = withTestDb();

  it("two concurrent calls for one new name produce exactly one vendor", async () => {
    // The reason `findOrCreateVendor` goes through `findOrCreate`
    // (`ON CONFLICT DO NOTHING` + re-select) rather than findFirst + insert:
    // two concurrent imports naming the same new vendor must yield one row, not
    // a 500 on the normalized live-name unique index.
    const [a, b] = await Promise.all([
      findOrCreateVendor(ctx.db, " FLOW FORM PLUMBING "),
      findOrCreateVendor(ctx.db, "Flow Form Plumbing"),
    ]);

    expect(a).toBe(b);
    const rows = await getDb(ctx.db)
      .select({ id: vendor.id })
      .from(vendor)
      .where(sql`lower(btrim(${vendor.name})) = 'flow form plumbing'`);
    expect(rows).toHaveLength(1);
  });

  it("rejects duplicate live names and permits reuse after deletion", async () => {
    const original = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic maker",
    });
    await expect(
      insertWithShortcode(ctx.db, "vendor", { name: " SYNTHETIC MAKER " }),
    ).rejects.toMatchObject({ cause: { constraint: "Vendor_name_live_key" } });
    await getDb(ctx.db)
      .update(vendor)
      .set({ deletedAt: new Date() })
      .where(eq(vendor.id, original.id));
    const replacement = await findOrCreateVendor(ctx.db, "Synthetic maker");
    expect(replacement).not.toBe(original.id);
  });
});

describe("vendor declared scalar updates", () => {
  const ctx = withTestDb();

  // The detail screen prints this text (`display.detailLabelPath`) instead of
  // each client wording the structured hints.
  it("words the agent hints for the detail read", async () => {
    const id = await findOrCreateVendor(ctx.db, "Hinted vendor");
    const original = await readVendorById(ctx.db, id);
    expect(original.agentHintsLabel).toBeNull();

    const changed = await updateVendor(
      ctx.db,
      original.id,
      {
        agentHints: {
          ordersListUrl: "https://shop.example.test/orders",
          pagination: null,
          orderLinkPattern: null,
          notes: ["Sign in first"],
        },
      },
      ctx.actor,
    );
    expect(changed.output.agentHintsLabel).toBe(
      "Orders: https://shop.example.test/orders\nSign in first",
    );
  });
});

describe("vendor repository — spend rollup", () => {
  const ctx = withTestDb();

  it("derives exact roles for filtering and grouping and follows deleted references", async () => {
    const { output: identity, entityId: identityId } = await createRepoEntity(
      ctx,
      "vendor",
      { name: "Synthetic role vendor" },
    );
    const read = () =>
      readVendorById(ctx.db, parseEntityId("vendor", identityId));
    expect((await read()).role).toBe("unused");
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic role product",
        brandId: identity.id,
      }),
      ctx.actor,
    );
    expect((await read()).role).toBe("brand");
    const { output: order } = await createRepoEntity(ctx, "purchase", {
      date: "2024-01-15",
      vendorId: identity.id,
    });
    expect((await read()).role).toBe("both");
    expect(
      (
        await vendorScaffold.read(ctx.db, {
          filters: { search: "Synthetic role vendor", role: ["seller"] },
          sorts: [],
          pagination: page,
        })
      ).count,
    ).toBe(0);
    const grouped = await vendorScaffold.read(ctx.db, {
      filters: withListGroupBy(
        { search: "Synthetic role vendor", role: ["seller", "both"] },
        [{ key: "role" }],
      ),
      sorts: [],
      pagination: page,
    });
    expect(grouped.data.map((row) => row.role)).toEqual(["both"]);
    expect(grouped).toMatchObject({ groups: [{ label: "Both", count: 1 }] });
    await deleteProducts(ctx.db, [item.entityId], ctx.actor);
    expect((await read()).role).toBe("seller");
    await deletePurchases(ctx.db, [order.id], ctx.actor);
    expect((await read()).role).toBe("unused");
  });

  it("separates brand catalog and spend from seller history and coverage", async () => {
    const seller = await findOrCreateVendor(ctx.db, "Synthetic Seller");
    const brand = await findOrCreateVendor(ctx.db, "Synthetic Brand");
    const sellerRef = (await readVendorById(ctx.db, seller)).id;
    const { output: category } = await createRepoEntity(
      ctx,
      "productCategory",
      { name: "Synthetic category" },
    );
    await updateVendor(
      ctx.db,
      sellerRef,
      { itemizationExpectation: "required" },
      ctx.actor,
    );
    const branded = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic branded item",
        brandId: brand,
        categoryId: category.id,
      }),
      ctx.actor,
    );
    const removed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic removed item", brandId: brand }),
      ctx.actor,
    );
    await deleteProducts(ctx.db, [removed.entityId], ctx.actor);
    const { output: order } = await createRepoEntity(ctx, "purchase", {
      date: "2024-01-15",
      vendorId: sellerRef,
      itemizationExpectation: "required",
    });
    await createRepoEntity(ctx, "expense", {
      date: "2024-01-15",
      name: "Synthetic item line",
      trade: "other",
      costType: "materials",
      cost: 10,
      purchaseId: order.id,
      productId: branded.id,
    });
    await createRepoEntity(ctx, "expense", {
      date: "2024-01-15",
      name: "Synthetic brand refund",
      trade: "other",
      costType: "materials",
      cost: -3,
      purchaseId: order.id,
      productId: branded.id,
    });
    await createRepoEntity(ctx, "expense", {
      date: "2024-01-15",
      name: "Synthetic unattributed line",
      trade: "other",
      costType: "materials",
      cost: 5,
      purchaseId: order.id,
      lineKind: "unclassified",
    });
    const sellerRow = await readVendorById(ctx.db, seller);
    expect(sellerRow).toMatchObject({
      brandedProductCount: 0,
      brandSpend: 0,
      spend: 12,
      expenseCount: 3,
      firstPurchaseDate: "2024-01-15",
      documentedPurchaseCount: 0,
      missingItemizationCount: 1,
    });
    expect(await readVendorById(ctx.db, brand)).toMatchObject({
      brandedProductCount: 1,
      brandCategoryCount: 1,
      purchasedBrandProductCount: 1,
      brandSpend: 7,
      spend: 0,
      expenseCount: 0,
      firstPurchaseDate: null,
      missingItemizationCount: 0,
    });
    const listed = await vendorScaffold.read(ctx.db, {
      filters: {},
      sorts: [],
      pagination: page,
    });
    expect(
      listed.data.find((row) => row.id === sellerRef)?.brandedProductCount,
    ).toBe(0);
    expect(
      listed.data.find((row) => row.id === branded.brandId)
        ?.brandedProductCount,
    ).toBe(1);
    const brandRef = (await readVendorById(ctx.db, brand)).id;
    const previews = await loadRelatedPreviews(ctx.db, {
      source: "vendor",
      sourceIds: [sellerRef, brandRef],
      relationKeys: ["vendor.brandedProducts", "vendor.products"],
    });
    expect(
      previews
        .find(
          (preview) =>
            preview.sourceId === brandRef &&
            preview.relationKey === "vendor.brandedProducts",
        )
        ?.items.map((item) => item.id),
    ).toEqual([branded.id]);
    expect(
      previews.find(
        (preview) =>
          preview.sourceId === sellerRef &&
          preview.relationKey === "vendor.brandedProducts",
      )?.totalCount ?? 0,
    ).toBe(0);
    expect(
      previews
        .find(
          (preview) =>
            preview.sourceId === sellerRef &&
            preview.relationKey === "vendor.products",
        )
        ?.items.map((item) => item.id),
    ).toEqual([branded.id]);
  });

  it("spend is SUM(expense.cost), never the charge's statedTotal", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Spend Rollup Vendor");
    const vendorShortcode = (await readVendorById(ctx.db, vendorId)).id;
    const { output: charge } = await createRepoEntity(ctx, "purchase", {
      date: "2024-01-15",
      vendorId: vendorShortcode,
      orderId: "SPEND-1",
      // Wildly wrong on purpose. `statedTotal` is only a reconciliation cue;
      // if it ever reached `spend` this assertion would read 99999.
      statedTotal: 99999,
    });

    await createRepoEntity(ctx, "expense", {
      date: "2024-01-15",
      name: "spend line",
      trade: "other",
      costType: "materials",
      cost: 100,
      purchaseId: charge.id,
    });
    // A negative line (a refund) is real spend and must net in — never filtered
    // out, or the vendor's total stops reconciling.
    await createRepoEntity(ctx, "expense", {
      date: "2024-01-15",
      name: "spend refund",
      trade: "other",
      costType: "materials",
      cost: -25,
      purchaseId: charge.id,
    });

    const row = await readVendorById(ctx.db, vendorId);
    expect(row.spend).toBe(75);
    expect(row.spend).not.toBe(charge.statedTotal);
    expect(row.purchaseCount).toBe(1);
  });
});

describe("vendor coverage", () => {
  const ctx = withTestDb();

  it("uses inclusive boundaries, unique sorted order ids, and latest overall", async () => {
    const vendorId = await findOrCreateVendor(ctx.db, "Coverage Vendor");
    const vendorRow = await readVendorById(ctx.db, vendorId);
    for (const [date, orderId] of [
      ["2026-09-01", "OUTSIDE-EARLY"],
      ["2026-09-10", "ORDER-B"],
      ["2026-09-20", "ORDER-A"],
      ["2026-09-30", null],
      ["2026-10-01", "OUTSIDE-LATEST"],
    ] as const) {
      await createRepoEntity(ctx, "purchase", {
        date,
        vendorId: vendorRow.id,
        orderId,
      });
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
    const vendorShortcode = (await readVendorById(ctx.db, vendorId)).id;

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
      [(await readPurchaseById(ctx.db, charge)).id],
      ctx.actor,
    );
    await deleteVendors(ctx.db, [vendorShortcode], ctx.actor);

    await expect(readVendorById(ctx.db, vendorId)).rejects.toMatchObject({
      reason: "VENDOR_NOT_FOUND",
    });
    expect(
      (
        await vendorScaffold.read(ctx.db, {
          filters: {},
          sorts: [],
          pagination: page,
        })
      ).data.map((row) => row.id),
    ).not.toContain(vendorShortcode);
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

  it("preserves Purchase research committed while a Vendor merge waits for its row locks", async () => {
    const keep = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic locked keeper",
    });
    const lose = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic locked donor",
    });
    const keeper = await createRepoEntity(ctx, "purchase", {
      vendorId: keep.output.id,
      orderId: "SYNTHETIC-LOCKED-ORDER",
      notes: "Keeper research",
    });
    await createRepoEntity(ctx, "purchase", {
      vendorId: lose.output.id,
      orderId: "SYNTHETIC-LOCKED-ORDER",
      notes: "Donor research",
    });
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const editing = getDb(ctx.db).transaction(async (tx) => {
      await tx
        .select({ id: purchase.id })
        .from(purchase)
        .where(eq(purchase.id, keeper.entityId))
        .for("update");
      const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      locked.resolve(z.object({ pid: z.number() }).parse(result.rows[0]).pid);
      await release.promise;
      await tx
        .update(purchase)
        .set({ notes: sql`${purchase.notes} || E'\nConcurrent research'` })
        .where(eq(purchase.id, keeper.entityId));
    });
    const pid = await locked.promise;
    const merging = mergeVendors(
      ctx.db,
      { keepId: keep.output.id, mergeIds: [lose.output.id] },
      ctx.actor,
    );
    try {
      await expect
        .poll(async () => {
          const result = await getDb(ctx.db).execute(
            sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`,
          );
          return z.object({ waiting: z.boolean() }).parse(result.rows[0])
            .waiting;
        })
        .toBe(true);
    } finally {
      release.resolve();
      await editing;
    }
    await merging;
    const [saved] = await getDb(ctx.db)
      .select({ notes: purchase.notes })
      .from(purchase)
      .where(eq(purchase.id, keeper.entityId));
    expect(saved?.notes).toBe(
      "Keeper research\nConcurrent research\n\nDonor research",
    );
  });

  it("preserves both Vendor notes and folded Purchase notes without exact duplicates", async () => {
    const vendors = [];
    const purchases = [];
    for (const [index, notes] of [
      "  Keeper research\n",
      "First donor research  ",
      "Second donor research",
      "First donor research  ",
    ].entries()) {
      const row = (
        await createRepoEntity(ctx, "vendor", {
          name: `Synthetic notes vendor ${index}`,
          notes,
        })
      ).output;
      vendors.push(row);
      purchases.push(
        (
          await createRepoEntity(ctx, "purchase", {
            vendorId: row.id,
            orderId: "SYNTHETIC-SHARED-ORDER",
            date: "2026-01-01",
            notes,
          })
        ).output,
      );
    }
    const [keeper, first, second, duplicate] = vendors;
    const result = await mergeVendors(
      ctx.db,
      {
        keepId: keeper!.id,
        mergeIds: [second!.id, first!.id, duplicate!.id],
      },
      ctx.actor,
    );
    const expected =
      "  Keeper research\n\n\nSecond donor research\n\nFirst donor research  ";
    expect(result.vendor.notes).toBe(expected);
    const [survivor] = await getDb(ctx.db)
      .select({ notes: purchase.notes })
      .from(purchase)
      .where(
        and(eq(purchase.shortcode, purchases[0]!.id), notDeleted(purchase)),
      );
    expect(survivor?.notes).toBe(expected);
  });

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
    entityKind: "vendor" | "purchase" | "expense",
    entityId: string,
    action: "create" | "update" | "delete",
  ) =>
    getDb(ctx.db)
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, entityKind),
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
    (await readVendorById(ctx.db, id)).id;

  const addLine = async (name: string, cost: number, purchaseId: PurchaseId) =>
    createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name,
        cost,
        purchaseId: (await readPurchaseById(ctx.db, purchaseId)).id,
      }),
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
      entityId: purchaseId,
      entityKind: "purchase",
      imageId: img.id,
    });
    return { imageId: img.id, joinId: join.id };
  };

  // Returns the charge's internal uuid — every downstream helper here
  // (`chargeRow`, `getPurchaseExpenses`, `readPurchaseById`, the audit-row
  // lookups) is keyed on it, even though `createPurchase` itself now speaks
  // shortcodes at its public boundary.
  const charge = async (
    vendorId: VendorId,
    orderId: string | null,
    statedTotal: number | null = null,
  ): Promise<PurchaseId> => {
    const { output: created } = await createRepoEntity(ctx, "purchase", {
      date: "2024-01-15",
      vendorId: await vendorCode(vendorId),
      orderId,
      statedTotal,
    });
    const id = await resolveLiveShortcode(ctx.db, created.id, "purchase");
    if (!id) throw new Error(`purchase not found: ${created.id}`);
    return parseEntityId("purchase", id);
  };

  it("re-points the losers' charges, soft-deletes the losers, and unions the keeper's rollups", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "B&H Photo");
    const loser = await findOrCreateVendor(ctx.db, "B&H");

    await getDb(ctx.db)
      .update(vendor)
      .set({
        orderEmailSenders: [
          "receipts@synthetic-keep.example",
          "orders@synthetic-keep.example",
        ],
        orderEmailSenderPolicies: {
          "receipts@synthetic-keep.example": "learned",
          "orders@synthetic-keep.example": "learned",
        },
      })
      .where(eq(vendor.id, keeper));
    await getDb(ctx.db)
      .update(vendor)
      .set({
        orderEmailSenders: ["orders@synthetic-keep.example"],
        orderEmailSenderPolicies: {
          "receipts@synthetic-keep.example": "excluded",
          "orders@synthetic-keep.example": "confirmed",
        },
      })
      .where(eq(vendor.id, loser));
    const keeperCharge = await charge(keeper, "KEEP-1");
    const loserOrdered = await charge(loser, "LOSE-1");
    const loserCashRun = await charge(loser, null);

    await addLine("keeper line", 100, keeperCharge);
    await addLine("loser line", 40, loserOrdered);
    await addLine("cash run line", 10, loserCashRun);

    const moneyBefore = await liveExpenseTotal();
    // Captured BEFORE the merge: `vendorCode` reads through `readVendorById`,
    // which 404s on the loser the instant it's soft-deleted below.
    const keeperCode = await vendorCode(keeper);
    const loserCode = await vendorCode(loser);

    const { vendor: merged, mergeSummary } = await mergeVendors(
      ctx.db,
      { keepId: keeperCode, mergeIds: [loserCode] },
      ctx.actor,
    );

    expect(merged.id).toBe(keeperCode);
    const [senderIntent] = await getDb(ctx.db)
      .select({
        senders: vendor.orderEmailSenders,
        policies: vendor.orderEmailSenderPolicies,
      })
      .from(vendor)
      .where(eq(vendor.id, keeper));
    expect(senderIntent).toEqual({
      senders: ["orders@synthetic-keep.example"],
      policies: {
        "receipts@synthetic-keep.example": "excluded",
        "orders@synthetic-keep.example": "confirmed",
      },
    });

    // The loser's name stays findable: imports resolve it to the keeper.
    expect(merged.aliases).toEqual(["B&H"]);
    expect(await findOrCreateVendor(ctx.db, "B&H")).toBe(keeper);
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
      vendorAccountsMoved: 0,
      vendorAccountsFolded: 0,
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

    await expect(readVendorById(ctx.db, loser)).rejects.toMatchObject({
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
      vendorAccountsMoved: 0,
      vendorAccountsFolded: 0,
      carriedFields: [],
    });

    const lines = await getPurchaseExpenses(ctx.db, survivor);
    expect(lines.map((l) => l.name).sort()).toEqual([
      "folded line",
      "survivor line",
    ]);

    const survivorDocs = await getDb(ctx.db).query.entityAttachment.findMany({
      where: and(
        eq(entityAttachment.entityId, survivor),
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
    await expect(readPurchaseById(ctx.db, dead)).rejects.toMatchObject({
      reason: "PURCHASE_NOT_FOUND",
    });

    // The folded charge's money moved to the survivor, it did not disappear
    // with the charge.
    expect(await liveExpenseTotal()).toBe(moneyBefore);
  });

  // Failure mode: repointing two issuers onto one survivor gives it two
  // namespaces for one catalog, which once failed every identity scan.
  it("refuses to merge two Vendors that each issue Product identifiers", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "Synthetic issuer keeper");
    const loser = await findOrCreateVendor(ctx.db, "Synthetic issuer loser");
    await getDb(ctx.db)
      .insert(externalSource)
      .values([
        {
          slug: "synthetic-keeper-catalog",
          label: "Keeper",
          vendorId: keeper,
          issuer: true,
        },
        {
          slug: "synthetic-loser-catalog",
          label: "Loser",
          vendorId: loser,
          issuer: true,
        },
      ]);
    const loserCode = await vendorCode(loser);
    await expect(
      mergeVendors(
        ctx.db,
        { keepId: await vendorCode(keeper), mergeIds: [loserCode] },
        ctx.actor,
      ),
    ).rejects.toThrow(`${loserCode}: synthetic-loser-catalog`);
  });

  it("clears a deleted Vendor's issuer with its ownership", async () => {
    const doomed = await findOrCreateVendor(ctx.db, "Synthetic deleted issuer");
    await getDb(ctx.db).insert(externalSource).values({
      slug: "synthetic-deleted-catalog",
      label: "Deleted",
      vendorId: doomed,
      issuer: true,
    });
    await deleteVendors(ctx.db, [await vendorCode(doomed)], ctx.actor);
    expect(
      await getDb(ctx.db)
        .select({
          vendorId: externalSource.vendorId,
          issuer: externalSource.issuer,
        })
        .from(externalSource)
        .where(eq(externalSource.slug, "synthetic-deleted-catalog")),
    ).toEqual([{ vendorId: null, issuer: false }]);
  });

  it("carries a merged Vendor's export source to the survivor beside its issuer", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "Synthetic export keeper");
    const loser = await findOrCreateVendor(ctx.db, "Synthetic export loser");
    await getDb(ctx.db)
      .insert(externalSource)
      .values([
        {
          slug: "synthetic-export-catalog",
          label: "Keeper",
          vendorId: keeper,
          issuer: true,
        },
        { slug: "synthetic-export-orders", label: "Loser", vendorId: loser },
      ]);
    await mergeVendors(
      ctx.db,
      { keepId: await vendorCode(keeper), mergeIds: [await vendorCode(loser)] },
      ctx.actor,
    );
    expect(
      await getDb(ctx.db)
        .select({
          slug: externalSource.slug,
          vendorId: externalSource.vendorId,
          issuer: externalSource.issuer,
        })
        .from(externalSource)
        .orderBy(externalSource.slug),
    ).toEqual([
      { slug: "synthetic-export-catalog", vendorId: keeper, issuer: true },
      { slug: "synthetic-export-orders", vendorId: keeper, issuer: false },
    ]);
  });

  it("writes the full audit trail for a merge that folds a charge", async () => {
    const keeper = await findOrCreateVendor(ctx.db, "Audited Keeper");
    const { id: loser } = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic audited donor",
    });

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
