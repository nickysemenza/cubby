import { parseShortcodeFor, type ProductId } from "@cubby/schemas/identifiers";
import { commitPurchaseImportInput } from "@cubby/schemas/purchase-import";
import type { ExtractedOrderCandidate } from "@cubby/schemas/purchase-import";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb, withTransaction } from "~/server/db/helpers";
import {
  entityExternalId,
  externalSource,
  expense,
  importSourceOrder,
  importSourceProduct,
  inventoryEntry,
  product,
  purchase,
  sourceOrderObservation,
} from "~/server/db/schema";
import { listProductMatchRows } from "~/server/domains/product/repo/match/product-match-candidate";
import { syncProductExternalIds } from "~/server/domains/product/repo/update-helpers";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { lockPartySettlement } from "../repo/retained-settlement";
import { startImportRunFixture } from "../service/import-run.fixtures";
import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import {
  memberImport,
  prepareMemberImport,
  type MemberImportOrder,
  memberImportWorld,
} from "./order-import.fixtures";

const checksum = (digit: string) => digit.repeat(64);

describe("purchase import identifier collisions", () => {
  const ctx = withTestDb();

  async function shortcodeOf(productId: ProductId) {
    const [row] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, productId));
    if (!row) throw new Error("Product fixture was not created");
    return row.shortcode;
  }

  it("keeps the reviewed Product, leaves the identifier with its owner, and proposes the pair for review", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: "Collision import Amazon fixture",
        website: "https://www.amazon.com/orders",
        browserDomains: ["amazon.com", "www.amazon.com"],
      },
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const owner = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "ForgeWear trail shirt, blue, medium" }),
      ctx.actor,
    );
    const reviewed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "ForgeWear trail shirt, blue, large" }),
      ctx.actor,
    );
    await withTransaction(ctx.db, async (tx) => {
      await tx.insert(externalSource).values({
        slug: "amazon",
        label: "Example registered catalog",
        vendorId: vendor.id,
      });
      await tx.insert(entityExternalId).values({
        entityId: owner.entityId,
        entityKind: "product" as const,
        source: "amazon",
        kind: "asin",
        externalId: "B0COLLIDE1",
        isPrimary: true,
      });
    });
    const reviewedShortcode = await shortcodeOf(reviewed.entityId);
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });

    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:collision-order",
        itemOperationIds: ["prepare-item:collision-order"],
      },
      orders: [
        {
          stableOrderId: "collision-order",
          itemOperationId: "prepare-item:collision-order",
          source: {
            kind: "vendor_export" as const,
            externalKey: "amazon:order:111-0000000-4444444",
            checksum: checksum("c"),
          },
          evidenceChecksum: checksum("d"),
          extractionRevision: "amazon@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "111-0000000-4444444",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Amazon",
              currency: "USD",
              printedGrandTotal: 24.5,
              lines: [
                {
                  title: "ForgeWear trail shirt, blue, large",
                  amount: 24.5,
                  lineKind: "principal" as const,
                  sku: "FW-TRAIL-BLU-L",
                  productUrl: "https://www.amazon.com/dp/B0COLLIDE1",
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["collision-order:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: "commit:collision-order" },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: "collision-order",
          stableLineId: "collision-order:line-1",
          resolution: {
            kind: "existing" as const,
            productId: reviewedShortcode,
          },
        },
      ],
    });
    const first = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(await commitPurchaseImport(ctx.db, commitInput, ctx.actor)).toEqual(
      first,
    );

    const [written] = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "111-0000000-4444444"));
    expect(written).toBeDefined();
    expect(
      await getDb(ctx.db)
        .select({ productId: expense.productId })
        .from(expense)
        .where(eq(expense.purchaseId, written!.id)),
    ).toEqual([{ productId: reviewed.entityId }]);

    // The colliding ASIN is never reassigned; the line's own SKU is learned.
    const identifiers = await getDb(ctx.db)
      .select({
        entityId: entityExternalId.entityId,
        kind: entityExternalId.kind,
        externalId: entityExternalId.externalId,
      })
      .from(entityExternalId);
    expect(identifiers).toEqual(
      expect.arrayContaining([
        { entityId: owner.entityId, kind: "asin", externalId: "B0COLLIDE1" },
        {
          entityId: reviewed.entityId,
          kind: "retailer_sku",
          externalId: "FW-TRAIL-BLU-L",
        },
      ]),
    );
    expect(
      identifiers.filter((row) => row.externalId === "B0COLLIDE1"),
    ).toHaveLength(1);

    const proposals = (await listProductMatchRows(ctx.db, owner.entityId))
      .filter(
        (row) =>
          row.productAId === reviewed.entityId ||
          row.productBId === reviewed.entityId,
      )
      .map((row) => ({ state: row.state, evidence: row.evidence }));
    expect(proposals).toEqual([
      { state: "open", evidence: expect.stringContaining("B0COLLIDE1") },
    ]);
  });

  // Concurrent imports must neither duplicate spend nor deadlock: a canonical
  // identifier written while an import waits must survive it, and two sources
  // naming the same Products in opposite order must both commit.
  async function reuseScope() {
    const { party, vendor: seller } = await memberImportWorld(
      ctx.db,
      ctx.actor,
      {
        vendor: {
          name: "Synthetic instrument seller",
        },
      },
    );
    const copper = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic copper instrument",
        manufacturer: "Synthetic Instruments",
        model: "COPPER-XL",
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0SYNTHXL1",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    const blue = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic blue instrument",
        model: "BLUE-SMALL",
      }),
      ctx.actor,
    );
    const order = async (
      sourceKey: string,
      orderId: string,
      item: typeof copper,
    ): Promise<MemberImportOrder> => {
      const [row] = await getDb(ctx.db)
        .select({ shortcode: product.shortcode, name: product.name })
        .from(product)
        .where(eq(product.id, item.entityId));
      if (!row) throw new Error("Product fixture was not created");
      const candidate: ExtractedOrderCandidate = {
        orderId,
        orderedAt: "2026-09-01T12:00:00Z",
        merchant: seller.name,
        currency: "USD",
        printedGrandTotal: 24,
        lines: [
          { title: row.name, amount: 24, quantity: 1, lineKind: "principal" },
        ],
        payments: [],
        allShipmentsDelivered: false,
      };
      return {
        stableOrderId: orderId.toLowerCase(),
        vendorId: seller.shortcode,
        source: {
          kind: "receipt_photo",
          externalKey: `synthetic:${sourceKey}`,
          checksum: checksum(sourceKey === "first" ? "a" : "b"),
        },
        extraction: { status: "ready", candidate },
        resolutions: [
          {
            kind: "existing",
            productId: parseShortcodeFor("product", row.shortcode),
          },
        ],
      };
    };
    return { party, copper, blue, order };
  }

  const waiting = async (query: ReturnType<typeof sql>) => {
    const result = await getDb(ctx.db).execute(query);
    return z.object({ count: z.number() }).parse(result.rows[0]).count;
  };

  it("serializes a concurrent canonical identifier insertion", async () => {
    const f = await reuseScope();
    await memberImport(ctx.db, ctx.actor, {
      key: "first-original",
      orders: [await f.order("first", "SYNTHETIC-REUSE", f.copper)],
      defaultTrade: "other",
    });
    const second = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "second-original",
      orders: [await f.order("second", "SYNTHETIC-REUSE", f.copper)],
      defaultTrade: "other",
    });
    const [existing] = await getDb(ctx.db).select().from(purchase);
    if (!existing) throw new Error("Imported Purchase missing.");
    const beforeExpenses = await getDb(ctx.db).select().from(expense);
    let imported: ReturnType<typeof second.commit> | undefined;
    let changed: Promise<void> | undefined;
    let changeSettled = false;
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx
          .select({ id: purchase.id })
          .from(purchase)
          .where(eq(purchase.id, existing.id))
          .for("update");
        imported = second.commit();
        imported.catch(() => undefined);
        await expect
          .poll(
            () =>
              waiting(sql`SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%"Purchase"%'`),
            { timeout: 5_000, interval: 20 },
          )
          .toBe(1);
        changed = withTransaction(ctx.db, (mutation) =>
          syncProductExternalIds(mutation, f.copper.entityId, [
            {
              source: "amazon",
              kind: "asin",
              externalId: "B0SYNTHXL1",
              url: null,
              isPrimary: true,
            },
            {
              source: "amazon",
              kind: "asin",
              externalId: "B0SYNTHNEW",
              url: null,
              isPrimary: false,
            },
          ]),
        ).finally(() => {
          changeSettled = true;
        });
        changed.catch(() => undefined);
        // The identifier write either commits first or waits on the import's
        // Product lock; it must never wait on this Purchase lock.
        await expect
          .poll(
            async () =>
              changeSettled ||
              (await waiting(sql`SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%"Product"%'`)) > 0,
            { timeout: 5_000, interval: 20 },
          )
          .toBe(true);
      });
    } finally {
      if (imported) await imported;
      if (changed) await changed;
    }
    expect(await getDb(ctx.db).select().from(expense)).toEqual(beforeExpenses);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      2,
    );
    expect(
      await getDb(ctx.db)
        .select({ externalId: entityExternalId.externalId })
        .from(entityExternalId)
        .where(
          and(
            eq(entityExternalId.entityId, f.copper.entityId),
            eq(entityExternalId.kind, "asin"),
          ),
        ),
    ).toContainEqual({ externalId: "B0SYNTHNEW" });
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("serializes same-member two-source imports with opposite Product order without a database deadlock", async () => {
    const f = await reuseScope();
    const first = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "copper-first",
      orders: [
        await f.order("first", "SYNTHETIC-REUSE-A", f.copper),
        await f.order("first", "SYNTHETIC-REUSE-B", f.blue),
      ],
      defaultTrade: "other",
    });
    const second = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "blue-first",
      orders: [
        await f.order("second", "SYNTHETIC-REUSE-B", f.blue),
        await f.order("second", "SYNTHETIC-REUSE-A", f.copper),
      ],
      defaultTrade: "other",
    });
    let commits:
      | Promise<
          PromiseSettledResult<Awaited<ReturnType<typeof first.commit>>>[]
        >
      | undefined;
    let statuses: string[] = [];
    try {
      await withTransaction(ctx.db, async (tx) => {
        await lockPartySettlement(tx, f.party.id);
        commits = Promise.allSettled([first.commit(), second.commit()]);
        await expect
          .poll(
            () =>
              waiting(sql`SELECT count(*)::int AS count FROM pg_locks
                WHERE locktype = 'advisory' AND NOT granted
                  AND objid::bigint = (hashtext(${`purchase-settlement:${f.party.id}`})::bigint & 4294967295)`),
            { timeout: 5_000, interval: 20 },
          )
          .toBe(2);
      });
    } finally {
      if (commits) statuses = (await commits).map(({ status }) => status);
    }
    expect(statuses).toEqual(["fulfilled", "fulfilled"]);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      4,
    );
    // Equivalent second sources retain both orders without duplicating the
    // accepted Product bindings, Expenses or physical receipts.
    expect(await getDb(ctx.db).select().from(importSourceProduct)).toHaveLength(
      2,
    );
    expect(
      await getDb(ctx.db).select().from(sourceOrderObservation),
    ).toHaveLength(4);
    const lines = await getDb(ctx.db).select().from(expense);
    expect(lines.map((row) => row.productId).sort()).toEqual(
      [f.copper.entityId, f.blue.entityId].sort(),
    );
    expect(lines.reduce((total, row) => total + Number(row.cost), 0)).toBe(48);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });
});
