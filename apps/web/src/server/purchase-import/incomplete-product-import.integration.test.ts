import {
  userId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  acceptedSourceOrder,
  type ImportWriterInput,
} from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  entityLink,
  importSourceOrder,
  importSourceProduct,
  inventoryEntry,
  product,
  purchase,
  runFinding,
  user,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { findOrphanedProducts } from "~/server/repo/problems/detectors-product";
import { deleteProducts } from "~/server/repo/product/crud";
import { mergeProducts } from "~/server/repo/product/merge";
import {
  listPurchaseProducts,
  listProductPurchases,
} from "~/server/repo/purchase-products";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import {
  purchasedResearchProducts,
  startProductResearch,
} from "./product-research-run";
import { loadProductPurchaseContext } from "./research-context";
import { importVendorOrder } from "./writer";

// Missing money/date must not suppress supported Product identity or manufacture
// financial/stock rows; replay, an existing identity, and a competing identity
// must retain their source binding and member visibility fences. A Product merge
// must preserve the original variant; removing an editable Purchase link must
// neither orphan nor permit deleting a Product still named by original evidence.
// A printed calendar day must not shift through UTC parsing; a true instant uses
// the household day, and a missing day cannot be supplied by the import time.
describe("incomplete itemized purchase identity", () => {
  const ctx = withTestDb();
  async function scope() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Incomplete source owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example variant maker",
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "account_sync",
      trigger: "manual",
      status: "running",
    });
    const input: ImportWriterInput = {
      runId,
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      vendorAccountId: null,
      defaultTrade: "other",
      source: {
        kind: "mail_message",
        externalKey: "gmail:example-mailbox:incomplete-itemized",
        checksum: "a".repeat(64),
      },
      extraction: {
        status: "ready",
        candidate: {
          orderId: "EXAMPLE-INCOMPLETE",
          orderedAt: null,
          merchant: "Example variant maker",
          currency: "USD",
          printedGrandTotal: null,
          lines: [
            {
              title: "Q-17 blue small device",
              amount: 24,
              lineKind: "principal",
              sku: "Q17-BLUE-SMALL",
              productUrl:
                "https://maker.example.test/q17?size=small&color=blue",
            },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
      productResolutions: [{ kind: "new", lineIndex: 0 }],
      primaryDocumentImageId: null,
      screenshotImageId: null,
    };
    return { party, vendor, input };
  }

  it.each([
    { orderedAt: "2032-02-29", expectedDate: "2032-02-29" },
    {
      orderedAt: "2033-07-11T04:32:43.000Z",
      expectedDate: "2033-07-10",
    },
    {
      orderedAt: "2033-07-11T13:32:43+09:00",
      expectedDate: "2033-07-10",
    },
    { orderedAt: null, expectedDate: null },
  ])(
    "preserves a source order day through itemized writing and stock-neutral replay ($orderedAt)",
    async ({ orderedAt, expectedDate }) => {
      const { input } = await scope();
      const candidate = input.extraction.candidate!;
      candidate.orderedAt = orderedAt;
      candidate.printedGrandTotal = 24;
      candidate.lines[0]!.quantity = 2;
      candidate.allShipmentsDelivered = true;

      const first = await importVendorOrder(ctx.db, input, ctx.actor.userId);
      if (!first.purchaseId)
        throw new Error("Synthetic dated Purchase missing");
      const purchaseId = parseEntityId("purchase", first.purchaseId);
      const [saved] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.id, purchaseId));
      expect(saved).toMatchObject({ date: expectedDate, statedTotal: 24 });
      const items = await getDb(ctx.db).select().from(product);
      expect(items).toHaveLength(1);
      const lines = await getDb(ctx.db)
        .select()
        .from(expense)
        .where(eq(expense.purchaseId, purchaseId));
      expect(
        lines.map(({ date, cost, lineKind, productId, productQuantity }) => ({
          date,
          cost,
          lineKind,
          productId,
          productQuantity,
        })),
      ).toEqual(
        expectedDate === null
          ? []
          : [
              {
                date: expectedDate,
                cost: 24,
                lineKind: "principal",
                productId: items[0]!.id,
                productQuantity: 2,
              },
            ],
      );
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);

      expect(
        await importVendorOrder(ctx.db, input, ctx.actor.userId),
      ).toMatchObject({ outcome: "replayed", purchaseId: first.purchaseId });
      expect(await getDb(ctx.db).select().from(product)).toEqual(items);
      expect(
        await getDb(ctx.db)
          .select()
          .from(expense)
          .where(eq(expense.purchaseId, purchaseId)),
      ).toEqual(lines);
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    },
  );

  it.each(["new", "existing"] as const)(
    "retains a supported %s Product and original ordered context without an Expense, then admits cloud research",
    async (kind) => {
      const { party, input } = await scope();
      const existing =
        kind === "existing"
          ? await insertWithShortcode(ctx.db, "product", {
              name: "Member label for Q-17",
              manufacturer: "Example maker",
            })
          : null;
      if (existing) {
        input.productResolutions = [
          { kind: "existing", lineIndex: 0, productId: existing.id },
        ];
        input.extraction.candidate!.orderedAt = "2026-09-01T18:00:00Z";
      }
      const first = await importVendorOrder(ctx.db, input, ctx.actor.userId);
      if (!first.purchaseId)
        throw new Error("Synthetic incomplete Purchase missing");
      const savedPurchaseId = parseEntityId("purchase", first.purchaseId);
      const [saved] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.id, savedPurchaseId));
      expect(saved).toMatchObject({
        date: existing ? "2026-09-01" : null,
        statedTotal: null,
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(expense)
          .where(eq(expense.purchaseId, savedPurchaseId)),
      ).toEqual([]);
      const items = await getDb(ctx.db).select().from(product);
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(await listPurchaseProducts(ctx.db, savedPurchaseId)).toMatchObject(
        [{ productId: item.shortcode, source: "link", movementKinds: [] }],
      );
      expect(await listProductPurchases(ctx.db, item.id)).toMatchObject([
        { purchaseId: saved!.shortcode, source: "link", movementKinds: [] },
      ]);
      expect(item.name).toBe(
        existing?.name ?? input.extraction.candidate?.lines[0]?.title,
      );
      const [association] = await getDb(ctx.db)
        .select()
        .from(importSourceOrder)
        .where(eq(importSourceOrder.purchaseId, savedPurchaseId));
      const original = acceptedSourceOrder.parse(association?.originalOrder);
      expect(original).toEqual({
        checksum: input.source.checksum,
        extraction: input.extraction,
      });
      expect(association?.originalOrder).toEqual(original);
      expect(
        await getDb(ctx.db)
          .select()
          .from(importSourceProduct)
          .where(eq(importSourceProduct.sourceOrderId, association!.id)),
      ).toMatchObject([{ lineIndex: 0, productId: item.id }]);
      expect(
        await loadProductPurchaseContext(ctx.db, {
          productId: item.id,
          ledgerPartyId: party.id,
        }),
      ).toMatchObject([
        {
          orderedLine: input.extraction.candidate?.lines[0],
          currentLine: null,
          source: { checksum: input.source.checksum },
          originalExtractions: [input.extraction],
        },
      ]);
      expect(
        await purchasedResearchProducts(getDb(ctx.db), {
          productIds: [item.id],
        }),
      ).toMatchObject([
        { productId: item.id, ledgerPartyId: party.id, expenseId: null },
      ]);
      const launched = await startProductResearch(
        ctx.db,
        {
          ledgerPartyId: party.id,
          userId: ctx.actor.userId,
          productIds: [item.id],
          cause: "scheduled",
        },
        { send: async () => {} },
      );
      expect(launched).toHaveLength(1);
      expect(
        await importVendorOrder(ctx.db, input, ctx.actor.userId),
      ).toMatchObject({ outcome: "replayed", purchaseId: first.purchaseId });
      expect(await getDb(ctx.db).select().from(product)).toHaveLength(1);
      expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
      const foreignUser = userId.parse(crypto.randomUUID());
      await getDb(ctx.db).insert(user).values({
        id: foreignUser,
        name: "Other example member",
        email: "incomplete-other@example.test",
      });
      const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Other source owner",
        kind: "member",
        userId: foreignUser,
      });
      expect(
        await loadProductPurchaseContext(ctx.db, {
          productId: item.id,
          ledgerPartyId: foreign.id,
        }),
      ).toEqual([]);
    },
  );

  it("keeps a competing item identity unresolved without fabricating a Product or financial line", async () => {
    const { input } = await scope();
    input.productResolutions = [
      {
        kind: "unresolved",
        lineIndex: 0,
        reason:
          "Two retained variants conflict; no exact selection is supported.",
      },
    ];
    const imported = await importVendorOrder(ctx.db, input, ctx.actor.userId);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFinding)
        .where(eq(runFinding.entityId, imported.purchaseId!)),
    ).toMatchObject([{ kind: "product_unresolved" }]);
    const [association] = await getDb(ctx.db)
      .select()
      .from(importSourceOrder)
      .where(
        eq(
          importSourceOrder.purchaseId,
          parseEntityId("purchase", imported.purchaseId!),
        ),
      );
    expect(acceptedSourceOrder.parse(association?.originalOrder)).toEqual({
      checksum: input.source.checksum,
      extraction: input.extraction,
    });
    expect(await getDb(ctx.db).select().from(importSourceProduct)).toEqual([]);
  });

  it("preserves original ordered variant and source-only research visibility when the Product merges", async () => {
    const { party, input } = await scope();
    const imported = await importVendorOrder(ctx.db, input, ctx.actor.userId);
    if (!imported.purchaseId) throw new Error("Synthetic Purchase missing");
    const savedPurchaseId = parseEntityId("purchase", imported.purchaseId);
    const [orderedProduct] = await getDb(ctx.db).select().from(product);
    if (!orderedProduct) throw new Error("Synthetic ordered Product missing");
    const keeper = await insertWithShortcode(ctx.db, "product", {
      name: "Member's current device label",
      manufacturer: "Example maker",
    });
    await mergeProducts(
      ctx.db,
      {
        keepId: keeper.shortcode,
        mergeIds: [parseShortcodeFor("product", orderedProduct.shortcode)],
      },
      ctx.actor,
    );
    expect(
      await loadProductPurchaseContext(ctx.db, {
        productId: keeper.id,
        ledgerPartyId: party.id,
      }),
    ).toMatchObject([
      {
        orderedLine: {
          title: "Q-17 blue small device",
          sku: "Q17-BLUE-SMALL",
          productUrl: "https://maker.example.test/q17?size=small&color=blue",
        },
        currentLine: null,
        source: { checksum: input.source.checksum },
        originalExtractions: [input.extraction],
      },
    ]);
    expect(
      await purchasedResearchProducts(getDb(ctx.db), {
        productIds: [keeper.id],
      }),
    ).toMatchObject([
      {
        productId: keeper.id,
        purchaseId: imported.purchaseId,
        ledgerPartyId: party.id,
        expenseId: null,
        name: "Q-17 blue small device",
      },
    ]);
    expect(await listProductPurchases(ctx.db, keeper.id)).toMatchObject([
      { source: "link", movementKinds: [] },
    ]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    const [association] = await getDb(ctx.db)
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.purchaseId, savedPurchaseId));
    expect(association?.originalOrder).toEqual({
      checksum: input.source.checksum,
      extraction: input.extraction,
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(importSourceProduct)
        .where(eq(importSourceProduct.sourceOrderId, association!.id)),
    ).toMatchObject([{ lineIndex: 0, productId: keeper.id }]);
    expect(
      await importVendorOrder(ctx.db, input, ctx.actor.userId),
    ).toMatchObject({
      outcome: "replayed",
      purchaseId: imported.purchaseId,
    });
    expect(
      await loadProductPurchaseContext(ctx.db, {
        productId: keeper.id,
        ledgerPartyId: party.id,
      }),
    ).toHaveLength(1);
  });

  it("retains a Product through original line evidence when its editable Purchase link is removed", async () => {
    const { input } = await scope();
    await importVendorOrder(ctx.db, input, ctx.actor.userId);
    const [item] = await getDb(ctx.db).select().from(product);
    if (!item) throw new Error("Synthetic Product missing");
    await getDb(ctx.db)
      .delete(entityLink)
      .where(
        and(
          eq(entityLink.kind, "purchaseProduct"),
          eq(entityLink.toEntityId, item.id),
        ),
      );
    expect(await findOrphanedProducts(ctx.db)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: item.shortcode })]),
    );
    await expect(deleteProducts(ctx.db, [item.id], ctx.actor)).rejects.toThrow(
      /original.*order|original.*line/i,
    );
    expect(
      await getDb(ctx.db).query.product.findFirst({
        where: eq(product.id, item.id),
      }),
    ).toMatchObject({ deletedAt: null });
  });
});
