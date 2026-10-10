import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityExternalId,
  expense,
  inventoryEntry,
  product,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { ensureExternalSources } from "~/server/repo/entity-external-ids";
import { findProductsByExternalIds } from "~/server/repo/product/find-by-external-ids";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { refreshSearchDocuments } from "~/server/repo/search-document";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";
import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { startImportRunFixture } from "./import-run.fixtures";

const checksum = (digit: string) => digit.repeat(64);
const MAKER = "ForgeWear Apparel";
const MAKER_SOURCE = "forgewear-apparel";

describe("manufacturer_part identity", () => {
  const ctx = withTestDb();

  const makeProduct = async (name: string) => {
    const created = await createProductFixture(
      ctx.db,
      makeProductInput({ name, manufacturer: MAKER, model: "TEE-100" }),
      ctx.actor,
    );
    const [row] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, created.entityId));
    return { id: created.entityId, shortcode: row!.shortcode };
  };

  it("round-trips, resolves a line to the exact Product, and only ranks a shared model", async () => {
    const black = await makeProduct("Crew Tee Black M");
    const blue = await makeProduct("Crew Tee Blue L");
    await withTransaction(ctx.db, async (tx) => {
      await ensureExternalSources(tx, [MAKER_SOURCE]);
      await learnPurchaseProductExternalId(tx, {
        productId: black.id,
        source: MAKER_SOURCE,
        kind: "manufacturer_part",
        externalId: "TEE-100-BLK-M",
      });
    });

    const stored = await getDb(ctx.db)
      .select({
        kind: entityExternalId.kind,
        source: entityExternalId.source,
        isPrimary: entityExternalId.isPrimary,
      })
      .from(entityExternalId)
      .where(
        and(
          eq(entityExternalId.entityId, black.id),
          notDeleted(entityExternalId),
        ),
      );
    expect(stored).toEqual([
      { kind: "manufacturer_part", source: MAKER_SOURCE, isPrimary: true },
    ]);
    const hits = await findProductsByExternalIds(ctx.db, [
      {
        source: MAKER_SOURCE,
        kind: "manufacturer_part",
        externalId: "TEE-100-BLK-M",
      },
    ]);
    expect([...hits.values()].flat().map(({ id }) => id)).toEqual([black.id]);

    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Manufacturer part member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "ForgeWear Outlet fixture",
      website: "https://www.forgewear.example.test/orders",
      browserDomains: ["forgewear.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Manufacturer part fixture account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const line = (title: string, sku: string) => ({
      title,
      amount: 20,
      lineKind: "principal" as const,
      sku,
      productUrl: "https://www.forgewear.example.test/p/crew-tee",
    });
    const prepared = await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          runId: run.id,
          operationId: "prepare:forge-1",
          itemOperationIds: ["prepare-item:forge-1"],
        },
        orders: [
          {
            stableOrderId: "forge-1",
            itemOperationId: "prepare-item:forge-1",
            source: {
              kind: "vendor_export" as const,
              externalKey: "forgewear:order:1001",
              checksum: checksum("a"),
            },
            evidenceChecksum: checksum("b"),
            extractionRevision: "forgewear@fixture-1",
            extraction: {
              status: "ready" as const,
              candidate: {
                orderId: "1001",
                orderedAt: "2026-09-20T12:00:00.000Z",
                merchant: "ForgeWear Outlet",
                currency: "USD",
                printedGrandTotal: 40,
                lines: [
                  // The SKU names the black/M variant exactly.
                  line(`${MAKER} Crew Tee TEE-100 Black M`, "TEE-100-BLK-M"),
                  // An unknown SKU: only the shared model can rank anything.
                  line(`${MAKER} Crew Tee TEE-100 Green S`, "TEE-100-GRN-S"),
                ],
                payments: [
                  { amount: 40, chargedAt: "2026-09-20T12:00:00.000Z" },
                ],
                allShipmentsDelivered: false,
              },
            },
            lineIds: ["forge-1:line-1", "forge-1:line-2"],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );

    const [exactLine, modelLine] = prepared.orders[0]!.lines;
    expect(exactLine?.candidates[0]).toMatchObject({
      productId: black.shortcode,
      exactIdentifierMatch: true,
    });
    // The sibling shares only the model/style number: ranked, never exact.
    expect(
      exactLine?.candidates.find(
        ({ productId }) => productId === blue.shortcode,
      ),
    ).toMatchObject({
      exactIdentifierMatch: false,
      matchReason: "shared model/style number; confirm size and color",
    });
    expect(modelLine?.candidates.length).toBeGreaterThanOrEqual(2);
    for (const candidate of modelLine?.candidates ?? []) {
      expect(candidate.exactIdentifierMatch).toBe(false);
      expect(candidate.matchReason).toContain("confirm size and color");
    }
  });

  // Common leading brand/category words can crowd the bounded candidate list;
  // aliases and later variant terms must rank before the limit, without proving identity.
  it("ranks an existing variant beyond alphabetic brand distractors before admitting a new Product", async () => {
    const existing = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Zeta deep socket kit 36-piece",
        manufacturer: "ForgeTools",
        model: "KIT-360",
        aliases: ["Impact Pro deep socket kit 36-piece"],
      }),
      ctx.actor,
    );
    const distractors = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        createProductFixture(
          ctx.db,
          makeProductInput({ name: `A ForgeTools impact drill ${index}` }),
          ctx.actor,
        ),
      ),
    );
    await refreshSearchDocuments(
      ctx.db,
      [existing, ...distractors].map(({ entityId }) => ({
        entityKind: "product",
        entityId,
      })),
    );
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic matching member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic tools retailer",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic tools account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepared = await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          runId: run.id,
          operationId: "prepare:ranked-kit",
          itemOperationIds: ["prepare-item:ranked-kit"],
        },
        orders: [
          {
            stableOrderId: "ranked-kit",
            itemOperationId: "prepare-item:ranked-kit",
            source: {
              kind: "vendor_export",
              externalKey: "synthetic:ranked-kit",
              checksum: checksum("a"),
            },
            evidenceChecksum: checksum("b"),
            extractionRevision: "synthetic@1",
            extraction: {
              status: "ready",
              candidate: {
                orderId: "ranked-kit",
                orderedAt: "2026-09-20",
                merchant: vendor.name,
                currency: "USD",
                printedGrandTotal: 20,
                lines: [
                  {
                    title: "ForgeTools Impact Pro deep socket kit 36-piece",
                    amount: 20,
                    quantity: 1,
                    lineKind: "principal",
                  },
                ],
                payments: [],
                allShipmentsDelivered: false,
              },
            },
            lineIds: ["ranked-kit:line-1"],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    expect(prepared.orders[0]?.lines[0]?.candidates[0]).toMatchObject({
      productId: existing.id,
      exactIdentifierMatch: false,
    });
    const commit = {
      _runExecution: { runId: run.id, operationId: "commit:ranked-kit" },
      prepareOperationId: "prepare:ranked-kit",
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "ranked-kit",
          stableLineId: "ranked-kit:line-1",
          resolution: { kind: "existing" as const, productId: existing.id },
        },
      ],
    };
    const written = await commitPurchaseImport(ctx.db, commit, ctx.actor);
    expect(await commitPurchaseImport(ctx.db, commit, ctx.actor)).toEqual(
      written,
    );
    expect(
      await getDb(ctx.db)
        .select({ productId: expense.productId, cost: expense.cost })
        .from(expense),
    ).toEqual([{ productId: existing.entityId, cost: 20 }]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    expect(
      await getDb(ctx.db).select({ id: product.id }).from(product),
    ).toHaveLength(25);
  });

  it("refuses a second Product claiming the same manufacturer part", async () => {
    const first = await makeProduct("Crew Tee Red M");
    const second = await makeProduct("Crew Tee Red M duplicate");
    const learn = (productId: typeof first.id) =>
      withTransaction(ctx.db, async (tx) => {
        await ensureExternalSources(tx, [MAKER_SOURCE]);
        return learnPurchaseProductExternalId(tx, {
          productId,
          source: MAKER_SOURCE,
          kind: "manufacturer_part",
          externalId: "TEE-100-RED-M",
        });
      });
    await learn(first.id);
    await expect(learn(second.id)).rejects.toBeInstanceOf(
      PurchaseProductExternalIdCollisionError,
    );
  });
});
