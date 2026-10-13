import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { importSourceKind } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { promoteHistoricalAcceptedOrders } from "tooling/historical-accepted-orders";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  expenseAttribution,
  importSourceClaim,
  importSourceOrder,
  importPreparedLine,
  inventoryEntry,
  ledgerParty,
  purchasePaymentEvidence,
  purchase,
  product,
  vendor as vendorTable,
  runFinding,
  run as runTable,
  sourceOrderObservation,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { mergePurchases } from "~/server/repo/purchase";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { mergeVendors } from "~/server/repo/vendor";

import { memberImport, memberImportWorld } from "./order-import.fixtures";
import {
  commitAcceptedSourceOrderReconciliation,
  prepareSourceOrderReconciliation,
} from "./reconciliation";
import { promoteHistoricalAcceptedObservation } from "./reconciliation-observations";

// The accepted-source path must associate a photographed Product without a
// fabricated finding, a second spend line, or stock receiving.
describe("reviewed accepted source Product association", () => {
  const ctx = withTestDb();
  async function world(linked = false, multi = false) {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: { name: "Synthetic photo retailer" },
    });
    const retainedProduct = multi
      ? await createProductFixture(
          ctx.db,
          makeProductInput({ name: "Synthetic retained item" }),
          ctx.actor,
        )
      : null;
    await memberImport(ctx.db, ctx.actor, {
      key: "accepted-photo-item",
      orders: [
        {
          stableOrderId: "accepted-photo-item",
          resolutions: retainedProduct
            ? [undefined, { kind: "existing", productId: retainedProduct.id }]
            : undefined,
          vendorId: vendor.shortcode,
          source: {
            kind: "receipt_photo",
            externalKey: "synthetic:photo-association",
            checksum: "a".repeat(64),
          },
          extraction: {
            status: "ready",
            candidate: {
              orderId: "SYNTHETIC-PHOTO-ITEM",
              orderedAt: "2026-09-01T18:00:00Z",
              merchant: "Synthetic photo retailer",
              currency: "USD",
              printedGrandTotal: multi ? 65 : 40,
              lines: [
                {
                  title: "Synthetic household item",
                  amount: 40,
                  quantity: 2,
                  lineKind: "principal",
                },
                ...(multi
                  ? [
                      {
                        title: "Synthetic retained item",
                        amount: 20,
                        quantity: 3,
                        lineKind: "principal" as const,
                      },
                      {
                        title: "Synthetic order tax",
                        amount: 5,
                        lineKind: "tax" as const,
                      },
                    ]
                  : []),
              ],
              payments: [
                { amount: multi ? 65 : 40, chargedAt: "2026-09-01T18:00:00Z" },
              ],
              allShipmentsDelivered: true,
            },
          },
        },
      ],
    });
    const db = getDb(ctx.db);
    const association = await db.query.importSourceOrder.findFirst();
    const item = await db.query.expense.findFirst({
      where: eq(expense.name, "Synthetic household item"),
    });
    if (!association || !item)
      throw new Error("Synthetic accepted item missing");
    const photographed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic photographed household item" }),
      ctx.actor,
    );
    if (linked)
      await db
        .update(expense)
        .set({ productId: photographed.entityId, productQuantity: 2 })
        .where(eq(expense.id, item.id));
    const retainedItem = multi
      ? await db.query.expense.findFirst({
          where: eq(expense.name, "Synthetic retained item"),
        })
      : null;
    const resolution = {
      kind: "attach_only" as const,
      lines: [
        {
          lineIndex: 0,
          expenseId: parseShortcodeFor("expense", item.shortcode),
          productId: photographed.id,
        },
      ],
    };
    const prepare = () =>
      prepareSourceOrderReconciliation(
        ctx.db,
        { sourceOrderId: association.id, resolution },
        ctx.actor,
      );
    const snapshot = async () => ({
      expenses: await db.select().from(expense),
      attributions: await db.select().from(expenseAttribution),
      payments: await db.select().from(purchasePaymentEvidence),
      stock: await db.select().from(inventoryEntry),
      findings: await db.select().from(runFinding),
      observations: await db.select().from(sourceOrderObservation),
    });
    return {
      db,
      party,
      vendor,
      association,
      item,
      photographed,
      retainedItem,
      retainedProduct,
      prepare,
      snapshot,
    };
  }

  type World = Awaited<ReturnType<typeof world>>;
  /** Make the accepted source's claim a historical alias of a new canonical root. */
  const linkCanonicalRoot = async (
    w: World,
    externalKey: string,
    checksum?: string,
  ) => {
    const alias = await w.db.query.importSourceClaim.findFirst();
    if (!alias) throw new Error("Synthetic source alias missing");
    const [root] = await w.db
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: w.party.id,
        kind: alias.kind,
        externalKey,
        checksum: checksum ?? alias.checksum,
        firstRunId: alias.firstRunId,
        lastRunId: alias.lastRunId,
      })
      .returning();
    if (!root) throw new Error("Synthetic canonical source missing");
    await w.db
      .update(importSourceClaim)
      .set({ canonicalClaimId: root.id })
      .where(eq(importSourceClaim.id, alias.id));
    return { alias, root };
  };
  const unknownEvidence = /unknown|immutable|evidence|Vendor|owner|member/i;

  // Historical snapshots promote only from checksum-matching stored extraction
  // under a live member and a provable Vendor; an alias reaching two accepted
  // orders is ambiguous. Each refusal stamps nothing and changes no evidence.
  it.each<{
    change: string;
    /** Clear the accepted observation so promotion must reconstruct it. */
    unaccepted: boolean;
    refusal: RegExp;
    arrange: (w: World) => Promise<void>;
  }>([
    {
      change: "an unrelated Vendor reassignment",
      unaccepted: true,
      refusal: unknownEvidence,
      arrange: async (w) => {
        const unrelated = await insertWithShortcode(ctx.db, "vendor", {
          name: "Synthetic unrelated retailer",
        });
        await w.db
          .update(purchase)
          .set({ vendorId: unrelated.id })
          .where(eq(purchase.id, w.association.purchaseId));
      },
    },
    {
      change: "an invalid historical Vendor",
      unaccepted: true,
      refusal: unknownEvidence,
      arrange: async (w) => {
        await w.db
          .update(importSourceOrder)
          .set({ orderKey: "unknown-vendor/order/SYNTHETIC-ACCEPTED-1" })
          .where(eq(importSourceOrder.id, w.association.id));
      },
    },
    {
      change: "a missing historical extraction",
      unaccepted: true,
      refusal: /unknown|immutable|evidence/i,
      arrange: async (w) => {
        await w.db
          .update(importSourceOrder)
          .set({ originalOrder: null })
          .where(eq(importSourceOrder.id, w.association.id));
      },
    },
    {
      change: "a checksum-mismatched historical extraction",
      unaccepted: true,
      refusal: /unknown|immutable|evidence/i,
      arrange: async (w) => {
        await w.db
          .update(importSourceOrder)
          .set({
            originalOrder: {
              ...w.association.originalOrder!,
              checksum: "b".repeat(64),
            },
          })
          .where(eq(importSourceOrder.id, w.association.id));
      },
    },
    {
      change: "a deleted member owner",
      unaccepted: true,
      refusal: unknownEvidence,
      arrange: async (w) => {
        await w.db
          .update(ledgerParty)
          .set({ deletedAt: new Date() })
          .where(eq(ledgerParty.id, w.party.id));
      },
    },
    {
      change: "a guest owner",
      unaccepted: true,
      refusal: unknownEvidence,
      arrange: async (w) => {
        const guest = await insertWithShortcode(ctx.db, "ledgerParty", {
          name: "Synthetic non-member source owner",
          kind: "guest",
        });
        await w.db
          .update(importSourceClaim)
          .set({ ledgerPartyId: guest.id })
          .where(eq(importSourceClaim.id, w.association.sourceClaimId));
      },
    },
    {
      change: "a deleted Vendor",
      unaccepted: true,
      refusal: unknownEvidence,
      arrange: async (w) => {
        await w.db
          .update(vendorTable)
          .set({ deletedAt: new Date() })
          .where(eq(vendorTable.id, w.vendor.id));
      },
    },
    {
      change: "an alias whose canonical root also holds the order",
      unaccepted: false,
      refusal: /duplicate|ambiguous|review|read-only/i,
      arrange: async (w) => {
        const { root } = await linkCanonicalRoot(
          w,
          "synthetic:ambiguous-canonical-photo",
        );
        await w.db.insert(importSourceOrder).values({
          sourceClaimId: root.id,
          orderKey: w.association.orderKey,
          purchaseId: w.association.purchaseId,
          checksum: w.association.checksum,
          outputFingerprint: w.association.outputFingerprint,
          originalOrder: w.association.originalOrder,
        });
      },
    },
  ])(
    "refuses historical accepted evidence with $change without stamping it",
    async ({ unaccepted, refusal, arrange }) => {
      const w = await world();
      if (unaccepted) {
        await w.db
          .update(importSourceOrder)
          .set({ acceptedObservationId: null })
          .where(eq(importSourceOrder.id, w.association.id));
        await w.db.delete(sourceOrderObservation);
      }
      await arrange(w);
      const snapshot = async () => ({
        ledger: await w.snapshot(),
        orders: await w.db.select().from(importSourceOrder),
        claims: await w.db.select().from(importSourceClaim),
        purchases: await w.db.select().from(purchase),
      });
      const before = await snapshot();
      const promoted = unaccepted
        ? await withTransaction(ctx.db, (tx) =>
            promoteHistoricalAcceptedObservation(tx, w.association.id),
          )
        : null;
      expect(promoted).toBeNull();
      await expect(w.prepare()).rejects.toThrow(refusal);
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await w.db.query.importSourceOrder.findFirst({
            where: eq(importSourceOrder.id, w.association.id),
          })
        )?.acceptedObservationId,
      ).toBe(unaccepted ? null : w.association.acceptedObservationId);
    },
  );

  it("historical Vendor promotion follows chained durable merges while retaining the original Vendor identity", async () => {
    const w = await world();
    await w.db
      .update(importSourceOrder)
      .set({ acceptedObservationId: null })
      .where(eq(importSourceOrder.id, w.association.id));
    await w.db.delete(sourceOrderObservation);
    let previous = w.vendor.shortcode;
    for (let step = 0; step < 2; step++) {
      const keeper = await insertWithShortcode(ctx.db, "vendor", {
        name: `Synthetic historical merged retailer ${step}`,
      });
      await mergeVendors(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [previous] },
        ctx.actor,
      );
      previous = keeper.shortcode;
    }
    const before = await w.snapshot();
    const promotedId = await withTransaction(ctx.db, (tx) =>
      promoteHistoricalAcceptedObservation(tx, w.association.id),
    );
    expect(promotedId).toBeTruthy();
    const observation = await w.db.query.sourceOrderObservation.findFirst();
    expect(observation).toMatchObject({
      vendorId: w.vendor.id,
      orderKey: w.association.orderKey,
      extraction: w.association.originalOrder?.extraction,
      checksum: w.association.checksum,
      runId: null,
    });
    const review = await w.prepare();
    await commitAcceptedSourceOrderReconciliation(
      ctx.db,
      { sourceOrderId: w.association.id, review },
      ctx.actor,
    );
    const after = await w.snapshot();
    expect(after.expenses).toEqual(
      before.expenses.map((row) => ({
        ...row,
        productId: w.photographed.entityId,
        productQuantity: 2,
        updatedAt: expect.any(Date),
      })),
    );
    expect(after.attributions).toEqual(before.attributions);
    expect(after.payments).toEqual(before.payments);
    expect(after.stock).toEqual(before.stock);
    expect(after.findings).toEqual(before.findings);
    expect(
      (await w.db.query.importSourceOrder.findFirst())?.originalOrder,
    ).toEqual(w.association.originalOrder);
    expect(after.observations.find((row) => row.id === promotedId)).toEqual(
      observation,
    );
  });

  // Historical snapshots can be promoted only from checksum-matching stored
  // extraction; mutable ledger state cannot reconstruct missing source facts.
  it("promotes a verifiable historical accepted snapshot before photo association", async () => {
    const w = await world();
    await w.db
      .update(importSourceOrder)
      .set({ acceptedObservationId: null })
      .where(eq(importSourceOrder.id, w.association.id));
    await w.db.delete(sourceOrderObservation);
    const before = await w.snapshot();
    const review = await w.prepare();
    const promoted = await w.db.query.importSourceOrder.findFirst();
    expect(promoted?.acceptedObservationId).toBeTruthy();
    expect(promoted?.originalOrder).toEqual(w.association.originalOrder);
    expect(promoted?.checksum).toBe(w.association.checksum);
    const observations = await w.db.select().from(sourceOrderObservation);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      extraction: w.association.originalOrder?.extraction,
      checksum: w.association.checksum,
      productBindings: [{ lineIndex: 0, productId: null }],
      runId: null,
      primaryDocumentImageId: null,
      screenshotImageId: null,
    });
    const result = await commitAcceptedSourceOrderReconciliation(
      ctx.db,
      { sourceOrderId: w.association.id, review },
      ctx.actor,
    );
    expect(result.alreadyApplied).toBe(false);
    const after = await w.snapshot();
    expect(after.expenses).toHaveLength(1);
    expect(after.expenses[0]).toMatchObject({
      id: w.item.id,
      cost: 40,
      productId: w.photographed.entityId,
      productQuantity: 2,
    });
    expect(after.attributions).toEqual(before.attributions);
    expect(after.payments).toEqual(before.payments);
    expect(after.stock).toEqual(before.stock);
    expect(after.findings).toEqual(before.findings);
    expect(
      (
        await commitAcceptedSourceOrderReconciliation(
          ctx.db,
          { sourceOrderId: w.association.id, review },
          ctx.actor,
        )
      ).alreadyApplied,
    ).toBe(true);
    expect(await w.snapshot()).toEqual(after);
  });

  // Merges retain immutable source identity while durable Entity redirects
  // prove which live association owns that original identity now.
  it.each(["purchase", "vendor"] as const)(
    "reviews accepted evidence after chained %s merges without changing its original identity",
    async (kind) => {
      const w = await world();
      const original = (await w.snapshot()).observations;
      const before = await w.snapshot();
      const staleReview = await w.prepare();
      let survivingPurchase = w.association.purchaseId;
      for (let step = 0; step < 2; step++) {
        if (kind === "purchase") {
          const keeper = await insertWithShortcode(ctx.db, "purchase", {
            vendorId: w.vendor.id,
            date: "2026-09-01",
            orderId: null,
          });
          const current = await w.db.query.purchase.findFirst({
            where: eq(purchase.id, survivingPurchase),
          });
          if (!current) throw new Error("Synthetic source Purchase missing");
          await mergePurchases(
            ctx.db,
            {
              keepId: keeper.shortcode,
              mergeIds: [parseShortcodeFor("purchase", current.shortcode)],
            },
            ctx.actor,
          );
          survivingPurchase = keeper.id;
        } else {
          const keeper = await insertWithShortcode(ctx.db, "vendor", {
            name: `Synthetic merged retailer ${step}`,
          });
          const current = await w.db.query.purchase.findFirst({
            where: eq(purchase.id, survivingPurchase),
          });
          const previous = current
            ? await w.db.query.vendor.findFirst({
                where: eq(vendorTable.id, current.vendorId),
              })
            : null;
          if (!previous) throw new Error("Synthetic source Vendor missing");
          await mergeVendors(
            ctx.db,
            {
              keepId: keeper.shortcode,
              mergeIds: [parseShortcodeFor("vendor", previous.shortcode)],
            },
            ctx.actor,
          );
        }
      }
      expect((await w.snapshot()).observations).toEqual(original);
      await expect(
        commitAcceptedSourceOrderReconciliation(
          ctx.db,
          { sourceOrderId: w.association.id, review: staleReview },
          ctx.actor,
        ),
      ).rejects.toThrow(/changed|review/i);
      const afterMerge = await w.snapshot();
      const review = await w.prepare();
      const result = await commitAcceptedSourceOrderReconciliation(
        ctx.db,
        { sourceOrderId: w.association.id, review },
        ctx.actor,
      );
      const after = await w.snapshot();
      expect(after.expenses).toHaveLength(1);
      expect(after.expenses[0]).toMatchObject({
        id: w.item.id,
        purchaseId: survivingPurchase,
        cost: 40,
        productId: w.photographed.entityId,
        productQuantity: 2,
      });
      expect(after.attributions).toEqual(before.attributions);
      expect(after.payments).toEqual(afterMerge.payments);
      expect(after.payments).toEqual(
        before.payments.map((row) => ({
          ...row,
          purchaseId: survivingPurchase,
          updatedAt: expect.any(Date),
        })),
      );
      expect(after.stock).toEqual(before.stock);
      expect(
        after.observations.filter((row) =>
          original.some((old) => old.id === row.id),
        ),
      ).toEqual(original);
      expect(result.alreadyApplied).toBe(false);
      expect(
        (
          await commitAcceptedSourceOrderReconciliation(
            ctx.db,
            { sourceOrderId: w.association.id, review },
            ctx.actor,
          )
        ).alreadyApplied,
      ).toBe(true);
      expect(await w.snapshot()).toEqual(after);
    },
  );

  it("replays the accepted source through a merged Vendor without duplicate spend or receiving", async () => {
    const w = await world();
    const keeper = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic canonical retailer",
    });
    await mergeVendors(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [w.vendor.shortcode] },
      ctx.actor,
    );
    const before = await w.snapshot();
    const claim = await w.db.query.importSourceClaim.findFirst();
    if (!claim || !w.association.originalOrder)
      throw new Error("Synthetic accepted source missing");
    const result = await memberImport(ctx.db, ctx.actor, {
      key: "merged-retailer-replay",
      orders: [
        {
          stableOrderId: "merged-retailer-replay",
          vendorId: keeper.shortcode,
          source: {
            kind: importSourceKind.exclude(["browser_order"]).parse(claim.kind),
            externalKey: claim.externalKey,
            checksum: w.association.checksum,
          },
          extraction: w.association.originalOrder.extraction,
        },
      ],
    });
    expect(result.committed.items[0]?.outcome).toBe("replayed");
    expect(await w.snapshot()).toEqual(before);
    expect(await w.db.select().from(importSourceOrder)).toHaveLength(1);
  });

  it("prepares a canonical family's historical alias without rewriting the observation or alias identity", async () => {
    const w = await world();
    const { alias, root } = await linkCanonicalRoot(
      w,
      "synthetic:canonical-photo-source",
    );
    const before = await w.snapshot();
    const aliasedClaim = await w.db.query.importSourceClaim.findFirst({
      where: eq(importSourceClaim.id, alias.id),
    });
    const review = await w.prepare();
    expect(review.source.externalKey).toBe(root.externalKey);
    expect(await w.snapshot()).toEqual(before);
    await commitAcceptedSourceOrderReconciliation(
      ctx.db,
      { sourceOrderId: w.association.id, review },
      ctx.actor,
    );
    const after = await w.snapshot();
    expect(after.expenses).toHaveLength(1);
    expect(after.expenses[0]).toMatchObject({
      id: w.item.id,
      cost: 40,
      productId: w.photographed.entityId,
    });
    expect(after.attributions).toEqual(before.attributions);
    expect(after.payments).toEqual(before.payments);
    expect(after.stock).toEqual(before.stock);
    expect(
      after.observations.filter((row) => row.id === before.observations[0]?.id),
    ).toEqual(before.observations);
    expect(
      (await w.db.query.importSourceOrder.findFirst())?.sourceClaimId,
    ).toBe(alias.id);
    expect(
      await w.db.query.importSourceClaim.findFirst({
        where: eq(importSourceClaim.id, alias.id),
      }),
    ).toEqual(aliasedClaim);
    expect(
      (
        await commitAcceptedSourceOrderReconciliation(
          ctx.db,
          { sourceOrderId: w.association.id, review },
          ctx.actor,
        )
      ).alreadyApplied,
    ).toBe(true);
  });
  it.each(["exact", "cosmetic"] as const)(
    "canonical %s replay preserves the historical alias and conserves money and stock",
    async (revision) => {
      const w = await world();
      const original = w.association.originalOrder;
      if (!original?.extraction.candidate)
        throw new Error("Synthetic historical source missing");
      const { alias, root } = await linkCanonicalRoot(
        w,
        "synthetic:canonical-replay-source",
        "c".repeat(64),
      );
      const historical = await w.db.query.importSourceClaim.findFirst({
        where: eq(importSourceClaim.id, alias.id),
      });
      const before = await w.snapshot();
      const checksum =
        revision === "exact" ? w.association.checksum : "b".repeat(64);
      const result = await memberImport(ctx.db, ctx.actor, {
        key: `canonical-${revision}-replay`,
        orders: [
          {
            stableOrderId: `canonical-${revision}-replay`,
            vendorId: w.vendor.shortcode,
            source: {
              kind: importSourceKind
                .exclude(["browser_order"])
                .parse(root.kind),
              externalKey: root.externalKey,
              checksum,
            },
            extraction:
              revision === "exact"
                ? original.extraction
                : {
                    ...original.extraction,
                    candidate: {
                      ...original.extraction.candidate,
                      merchant: "Synthetic refreshed merchant label",
                    },
                  },
          },
        ],
      });
      expect(result.committed.items[0]?.outcome).toBe(
        revision === "exact" ? "replayed" : "updated",
      );
      const replayRun = await w.db.query.run.findFirst({
        where: eq(
          runTable.shortcode,
          parseShortcodeFor("run", result.prepared.runId),
        ),
      });
      if (!replayRun) throw new Error("Synthetic replay Run missing");
      expect(
        await w.db.query.importSourceClaim.findFirst({
          where: eq(importSourceClaim.id, alias.id),
        }),
      ).toEqual(historical);
      expect(
        await w.db.query.importSourceClaim.findFirst({
          where: eq(importSourceClaim.id, root.id),
        }),
      ).toMatchObject({
        checksum,
        firstRunId: root.firstRunId,
        lastRunId: replayRun.id,
      });
      const after = await w.snapshot();
      expect(after.expenses).toEqual(before.expenses);
      expect(after.attributions).toEqual(before.attributions);
      expect(after.payments).toEqual(before.payments);
      expect(after.stock).toEqual(before.stock);
      expect(await w.db.select().from(importSourceOrder)).toEqual([
        expect.objectContaining({
          id: w.association.id,
          sourceClaimId: alias.id,
          purchaseId: w.association.purchaseId,
          checksum,
        }),
      ]);
    },
  );

  // One selected photo item still reviews the complete retained order roster.
  it("expands one selected item into a reviewed two-item and tax roster without changing untouched ledger state", async () => {
    const w = await world(false, true);
    if (!w.retainedItem || !w.retainedProduct)
      throw new Error("Synthetic retained line missing");
    const before = await w.snapshot();
    expect(before.observations[0]?.productBindings[1]).toEqual({
      lineIndex: 1,
      productId: w.retainedProduct.entityId,
    });
    const tax = before.expenses.find((row) => row.lineKind === "tax");
    if (!tax) throw new Error("Synthetic tax line missing");
    const review = await w.prepare();
    expect(review.resolution.lines).toEqual([
      {
        lineIndex: 0,
        expenseId: parseShortcodeFor("expense", w.item.shortcode),
        productId: w.photographed.id,
      },
      {
        lineIndex: 1,
        expenseId: parseShortcodeFor("expense", w.retainedItem.shortcode),
        productId: w.retainedProduct.id,
      },
      {
        lineIndex: 2,
        expenseId: parseShortcodeFor("expense", tax.shortcode),
        productId: null,
      },
    ]);
    expect(review.spend).toEqual({ before: 65, after: 65, delta: 0 });
    expect(await w.snapshot()).toEqual(before);
    await commitAcceptedSourceOrderReconciliation(
      ctx.db,
      { sourceOrderId: w.association.id, review },
      ctx.actor,
    );
    const after = await w.snapshot();
    expect(after.expenses).toHaveLength(3);
    expect(after.expenses.find((row) => row.id === w.item.id)).toMatchObject({
      cost: 40,
      productId: w.photographed.entityId,
      productQuantity: 2,
    });
    expect(after.expenses.filter((row) => row.id !== w.item.id)).toEqual(
      before.expenses.filter((row) => row.id !== w.item.id),
    );
    expect(after.attributions).toEqual(before.attributions);
    expect(after.payments).toEqual(before.payments);
    expect(after.stock).toEqual(before.stock);
    expect(after.findings).toEqual(before.findings);
    expect(
      (
        await commitAcceptedSourceOrderReconciliation(
          ctx.db,
          { sourceOrderId: w.association.id, review },
          ctx.actor,
        )
      ).alreadyApplied,
    ).toBe(true);
    expect(await w.snapshot()).toEqual(after);
    const nextReview = await w.prepare();
    await w.db
      .update(expense)
      .set({ cost: 21 })
      .where(eq(expense.id, w.retainedItem.id));
    const staleState = await w.snapshot();
    await expect(
      commitAcceptedSourceOrderReconciliation(
        ctx.db,
        { sourceOrderId: w.association.id, review: nextReview },
        ctx.actor,
      ),
    ).rejects.toThrow(/changed|review|preserve/i);
    expect(await w.snapshot()).toEqual(staleState);
  });

  it.each(["ambiguous", "missing"] as const)(
    "refuses %s untouched accepted line mappings before preparing a partial association",
    async (kind) => {
      const w = await world(false, true);
      if (!w.retainedItem) throw new Error("Synthetic retained line missing");
      if (kind === "missing")
        await w.db
          .update(expense)
          .set({ deletedAt: new Date() })
          .where(eq(expense.id, w.retainedItem.id));
      else
        await insertWithShortcode(ctx.db, "expense", {
          name: "Synthetic retained item",
          cost: 20,
          date: w.retainedItem.date,
          purchaseId: w.association.purchaseId,
          lineKind: "principal",
          economicRole: "vendor",
          costType: "materials",
          productId: w.retainedProduct?.entityId,
          productQuantity: 3,
        });
      const before = await w.snapshot();
      await expect(w.prepare()).rejects.toThrow(
        /ambiguous|explicit|binding|unknown/i,
      );
      expect(await w.snapshot()).toEqual(before);
    },
  );

  it("reviews then links the same Expense and replays without money or stock effects", async () => {
    const w = await world();
    const before = await w.snapshot();
    const review = await w.prepare();
    expect(review.spend).toEqual({ before: 40, after: 40, delta: 0 });
    expect(await w.snapshot()).toEqual(before);
    const result = await commitAcceptedSourceOrderReconciliation(
      ctx.db,
      { sourceOrderId: w.association.id, review },
      ctx.actor,
    );
    expect(result.alreadyApplied).toBe(false);
    const after = await w.snapshot();
    expect(after.expenses).toHaveLength(1);
    expect(after.expenses[0]).toMatchObject({
      id: w.item.id,
      cost: 40,
      productId: w.photographed.entityId,
      productQuantity: 2,
    });
    expect(after.attributions).toEqual(before.attributions);
    expect(after.payments).toEqual(before.payments);
    expect(after.stock).toEqual(before.stock);
    expect(after.findings).toEqual(before.findings);
    expect(after.observations[0]).toEqual(before.observations[0]);
    expect(
      (
        await commitAcceptedSourceOrderReconciliation(
          ctx.db,
          { sourceOrderId: w.association.id, review },
          ctx.actor,
        )
      ).alreadyApplied,
    ).toBe(true);
    expect(await w.snapshot()).toEqual(after);
    await expect(
      commitAcceptedSourceOrderReconciliation(
        ctx.db,
        {
          sourceOrderId: w.association.id,
          review: { ...review, spend: { ...review.spend, before: 0 } },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/changed|review/i);
    await w.db
      .update(expense)
      .set({ cost: 41 })
      .where(eq(expense.id, w.item.id));
    await expect(
      commitAcceptedSourceOrderReconciliation(
        ctx.db,
        { sourceOrderId: w.association.id, review },
        ctx.actor,
      ),
    ).rejects.toThrow(/changed|review/i);
  });

  // A prior silent-success import has a known accepted original and immutable
  // prepared identities, but no Product binding. Repair creates only the
  // deliberately reviewed Product, preserving the original and all spend.
  it("creates a reviewed new Product from known accepted preparation and replays with conserved ledger evidence", async () => {
    const w = await world(false, true);
    await w.db.insert(expenseAttribution).values([
      {
        expenseId: w.item.id,
        role: "beneficiary",
        ledgerPartyId: w.party.id,
        weight: 1,
      },
      {
        expenseId: w.item.id,
        role: "funder",
        ledgerPartyId: w.party.id,
        weight: 1,
      },
    ]);
    const before = await w.snapshot();
    const productsBefore = await w.db.select().from(product);
    const resolution = {
      kind: "attach_only" as const,
      lines: [
        {
          lineIndex: 0,
          expenseId: parseShortcodeFor("expense", w.item.shortcode),
          productId: null,
          newProduct: { kind: "new" as const },
        },
      ],
    };
    const review = await prepareSourceOrderReconciliation(
      ctx.db,
      { sourceOrderId: w.association.id, resolution },
      ctx.actor,
    );
    expect(review.resolution.lines[0]).toMatchObject({
      newProduct: {
        kind: "new",
        preparedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(review.spend).toEqual({ before: 65, after: 65, delta: 0 });
    expect(await w.snapshot()).toEqual(before);
    expect(await w.db.select().from(product)).toEqual(productsBefore);
    await commitAcceptedSourceOrderReconciliation(
      ctx.db,
      { sourceOrderId: w.association.id, review },
      ctx.actor,
    );
    const created = await w.db.query.product.findFirst({
      where: eq(product.name, "Synthetic household item"),
    });
    if (!created) throw new Error("Reviewed accepted Product not created");
    const after = await w.snapshot();
    expect(after.expenses.find((row) => row.id === w.item.id)).toMatchObject({
      id: w.item.id,
      cost: 40,
      productId: created.id,
      productQuantity: 2,
    });
    expect(after.expenses.filter((row) => row.id !== w.item.id)).toEqual(
      before.expenses.filter((row) => row.id !== w.item.id),
    );
    expect(after.attributions).toEqual(before.attributions);
    expect(after.payments).toEqual(before.payments);
    expect(after.stock).toEqual(before.stock);
    expect(after.findings).toEqual(before.findings);
    expect(
      after.observations.find((row) => row.id === before.observations[0]?.id),
    ).toEqual(before.observations[0]);
    const accepted = await w.db.query.importSourceOrder.findFirst();
    expect(accepted?.originalOrder).toEqual(w.association.originalOrder);
    const observation = after.observations.find(
      (row) => row.id === accepted?.acceptedObservationId,
    );
    expect(observation?.productBindings[0]).toEqual({
      lineIndex: 0,
      productId: created.id,
    });
    expect(
      (
        await commitAcceptedSourceOrderReconciliation(
          ctx.db,
          { sourceOrderId: w.association.id, review },
          ctx.actor,
        )
      ).alreadyApplied,
    ).toBe(true);
    expect(await w.snapshot()).toEqual(after);
    expect(await w.db.select().from(product)).toHaveLength(
      productsBefore.length + 1,
    );
  });

  // A combined refusal hid whether exact item matching or another accepted
  // source blocked a repair; both must remain safe and identify their cause.
  it.each(["item mismatch", "competing source"] as const)(
    "explains accepted new Product repair refusal for %s without writes",
    async (cause) => {
      const w = await world();
      if (cause === "item mismatch")
        await w.db
          .update(expense)
          .set({ name: "Synthetic changed item" })
          .where(eq(expense.id, w.item.id));
      else
        await w.db.insert(importSourceOrder).values({
          sourceClaimId: w.association.sourceClaimId,
          orderKey: "synthetic:another-accepted-order",
          checksum: w.association.checksum,
          outputFingerprint: w.association.outputFingerprint,
          purchaseId: w.association.purchaseId,
          originalOrder: w.association.originalOrder,
          acceptedObservationId: w.association.acceptedObservationId,
        });
      const before = await w.snapshot();
      const products = await w.db.select().from(product);
      await expect(
        prepareSourceOrderReconciliation(
          ctx.db,
          {
            sourceOrderId: w.association.id,
            resolution: {
              kind: "attach_only",
              lines: [
                {
                  lineIndex: 0,
                  expenseId: parseShortcodeFor("expense", w.item.shortcode),
                  productId: null,
                  newProduct: { kind: "new" },
                },
              ],
            },
          },
          ctx.actor,
        ),
      ).rejects.toThrow(
        cause === "item mismatch"
          ? /exact matching item Expenses: 0/i
          : /other accepted source orders: 1/i,
      );
      expect(await w.snapshot()).toEqual(before);
      expect(await w.db.select().from(product)).toEqual(products);
    },
  );

  it.each([
    "prepared identity drift",
    "exact Product appears",
    "unknown preparation",
  ] as const)(
    "refuses accepted new Product repair after %s without partial Products or binding writes",
    async (change) => {
      const w = await world();
      const resolution = {
        kind: "attach_only" as const,
        lines: [
          {
            lineIndex: 0,
            expenseId: parseShortcodeFor("expense", w.item.shortcode),
            productId: null,
            newProduct: { kind: "new" as const },
          },
        ],
      };
      const review = await prepareSourceOrderReconciliation(
        ctx.db,
        { sourceOrderId: w.association.id, resolution },
        ctx.actor,
      );
      if (change === "prepared identity drift")
        await w.db
          .update(importPreparedLine)
          .set({ identifiers: { sku: "synthetic-changed-identity" } });
      if (change === "unknown preparation")
        await w.db.delete(importPreparedLine);
      if (change === "exact Product appears")
        await createProductFixture(
          ctx.db,
          makeProductInput({ name: "Synthetic household item" }),
          ctx.actor,
        );
      const before = await w.snapshot();
      const products = await w.db.select().from(product);
      await expect(
        commitAcceptedSourceOrderReconciliation(
          ctx.db,
          { sourceOrderId: w.association.id, review },
          ctx.actor,
        ),
      ).rejects.toThrow(/changed|prepar|exact|match|identity/i);
      expect(await w.snapshot()).toEqual(before);
      expect(await w.db.select().from(product)).toEqual(products);
    },
  );

  it.each(["exact", "cosmetic"] as const)(
    "returns explicit review for %s accepted-source replay with new Product choices",
    async (revision) => {
      const w = await world();
      const claim = await w.db.query.importSourceClaim.findFirst();
      const original = w.association.originalOrder;
      if (!claim || !original?.extraction.candidate)
        throw new Error("Synthetic original missing");
      const before = await w.snapshot();
      const result = await memberImport(ctx.db, ctx.actor, {
        key: `new-product-replay-${revision}`,
        orders: [
          {
            stableOrderId: `new-product-replay-${revision}`,
            vendorId: w.vendor.shortcode,
            source: {
              kind: "receipt_photo",
              externalKey: claim.externalKey,
              checksum:
                revision === "exact" ? w.association.checksum : "b".repeat(64),
            },
            extraction:
              revision === "exact"
                ? original.extraction
                : {
                    ...original.extraction,
                    candidate: {
                      ...original.extraction.candidate,
                      merchant: "Synthetic refreshed source label",
                    },
                  },
            resolutions: [{ kind: "new" }],
          },
        ],
      });
      expect(result.committed.items[0]).toMatchObject({
        outcome: "conflict",
        findingCount: 1,
      });
      expect(
        (await w.db.query.importSourceOrder.findFirst())?.originalOrder,
      ).toEqual(original);
      const after = await w.snapshot();
      expect(after.expenses).toEqual(before.expenses);
      expect(after.attributions).toEqual(before.attributions);
      expect(after.payments).toEqual(before.payments);
      expect(after.stock).toEqual(before.stock);
    },
  );

  it.each([
    "cost",
    "quantity",
    "product",
    "ownership",
    "accepted observation",
  ] as const)("rejects stale %s before any association", async (change) => {
    const w = await world(change === "quantity");
    const review = await w.prepare();
    if (change === "cost")
      await w.db
        .update(expense)
        .set({ cost: 41 })
        .where(eq(expense.id, w.item.id));
    if (change === "quantity")
      await w.db
        .update(expense)
        .set({ productQuantity: 3 })
        .where(eq(expense.id, w.item.id));
    if (change === "product")
      await w.db
        .update(expense)
        .set({ productId: w.photographed.entityId, productQuantity: 2 })
        .where(eq(expense.id, w.item.id));
    if (change === "ownership") {
      const other = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic other owner",
        kind: "guest",
      });
      await w.db
        .update(importSourceClaim)
        .set({ ledgerPartyId: other.id })
        .where(eq(importSourceClaim.id, w.association.sourceClaimId));
    }
    if (change === "accepted observation")
      await w.db
        .update(importSourceOrder)
        .set({ acceptedObservationId: null })
        .where(eq(importSourceOrder.id, w.association.id));
    const before = await w.snapshot();
    await expect(
      commitAcceptedSourceOrderReconciliation(
        ctx.db,
        { sourceOrderId: w.association.id, review },
        ctx.actor,
      ),
    ).rejects.toThrow(/changed|review|owner|member|immutable/i);
    expect(await w.snapshot()).toEqual(before);
  });

  it("refuses an existing quantity disagreement instead of stamping an association", async () => {
    const w = await world(true);
    await w.db
      .update(expense)
      .set({ productQuantity: 3 })
      .where(eq(expense.id, w.item.id));
    await expect(w.prepare()).rejects.toThrow(/quantity|preserve/i);
    expect((await w.snapshot()).expenses[0]?.productId).toBe(
      w.photographed.entityId,
    );
  });

  // The deployment transform preserves the real ledger and stock, skips
  // unverifiable originals and converges without changing accepted snapshots.
  it("deployment transform promotes only verifiable originals without changing money or stock and repeats with zero promotions", async () => {
    const { vendor: seller } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: { name: "Synthetic historical workshop" },
    });
    await memberImport(ctx.db, ctx.actor, {
      key: "synthetic-historical-transform",
      orders: ["known", "unknown"].map((key) => ({
        stableOrderId: key,
        vendorId: seller.shortcode,
        source: {
          kind: "vendor_export",
          externalKey: `synthetic:historical:${key}`,
          checksum: (key === "known" ? "a" : "b").repeat(64),
        },
        extraction: {
          status: "ready",
          candidate: {
            orderId: `SYNTHETIC-${key}`,
            orderedAt: "2026-09-01T18:00:00Z",
            merchant: seller.name,
            currency: "USD",
            printedGrandTotal: 40,
            lines: [
              {
                title: "Workshop admission",
                amount: 40,
                lineKind: "principal",
              },
            ],
            payments: [{ amount: 40, chargedAt: "2026-09-01T18:00:00Z" }],
            allShipmentsDelivered: false,
          },
        },
      })),
    });
    const database = getDb(ctx.db);
    const orders = await database.select().from(importSourceOrder);
    const known = orders.find((row) => row.checksum === "a".repeat(64));
    const unknown = orders.find((row) => row.checksum === "b".repeat(64));
    if (!known || !unknown)
      throw new Error("Synthetic accepted orders unavailable");
    await database
      .update(importSourceOrder)
      .set({ acceptedObservationId: null })
      .where(eq(importSourceOrder.id, known.id));
    await database
      .update(importSourceOrder)
      .set({ acceptedObservationId: null, originalOrder: null })
      .where(eq(importSourceOrder.id, unknown.id));
    const sku = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic retained stock" }),
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic shelf", type: "shelf" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: sku.id,
        locationId: shelf.id,
        amount: { value: 3, unit: "each" },
      },
      ctx.actor,
    );
    const stock = await database.select().from(inventoryEntry);
    expect(await promoteHistoricalAcceptedOrders(ctx.db)).toMatchObject({
      scanned: 2,
      promoted: 1,
      alreadyKnown: 0,
      unknown: 1,
      refused: 0,
      financialUnchanged: true,
    });
    const [accepted] = await database
      .select()
      .from(importSourceOrder)
      .where(eq(importSourceOrder.id, known.id));
    expect(accepted).toMatchObject({
      originalOrder: known.originalOrder,
      checksum: known.checksum,
      outputFingerprint: known.outputFingerprint,
      acceptedObservationId: known.acceptedObservationId,
    });
    expect(await database.select().from(inventoryEntry)).toEqual(stock);
    expect(await promoteHistoricalAcceptedOrders(ctx.db)).toMatchObject({
      scanned: 2,
      promoted: 0,
      alreadyKnown: 1,
      unknown: 1,
      financialUnchanged: true,
    });
  });
});
