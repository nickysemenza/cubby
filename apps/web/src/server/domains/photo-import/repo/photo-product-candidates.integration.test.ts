import { parseShortcodeFor, userId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { decideProductVariantComparisons } from "~/server/ai/semantic-decisions";
import { getDb } from "~/server/db/helpers";
import {
  entityExternalId,
  image,
  importSourceOrder,
  sourceOrderObservation,
  user,
} from "~/server/db/schema";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { memberImport } from "~/server/domains/purchase-import/operations/order-import.fixtures";
import { mergePurchases } from "~/server/domains/purchase/repo/purchase";
import { mergeVendors } from "~/server/domains/vendor/repo/vendor";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createInventoryFixture,
  createLocationFixture,
  makeLocationInput,
  createProductFixture,
  insertEntityAttachments,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  loadPhotoProductEvidence,
  findPhotoProductCandidates as queryPhotoProductCandidates,
} from "./photo-product-candidates";

describe("photo product candidates", () => {
  const ctx = withTestDb();
  const unknownVariant: DecisionPort = async (request) => {
    const criteria = request.questions.selection.criteria;
    const choice = Object.entries(criteria).find(
      ([, value]) => value === "color unknown; size unknown",
    )?.[0];
    if (!choice) throw new Error("Expected unknown variant option");
    const keys = Object.keys(criteria);
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence: 0.99,
          probabilities: Object.fromEntries(
            keys.map((key) => [
              key,
              key === choice ? 0.99 : 0.01 / (keys.length - 1),
            ]),
          ),
        },
      },
    };
  };
  const findPhotoProductCandidates = (
    db: Parameters<typeof queryPhotoProductCandidates>[0],
    input: Parameters<typeof queryPhotoProductCandidates>[1],
    actor: Parameters<typeof queryPhotoProductCandidates>[2],
    port: DecisionPort = unknownVariant,
  ) =>
    queryPhotoProductCandidates(db, input, actor, (args) =>
      decideProductVariantComparisons({ ...args, port }),
    );

  // A model budget cap or OCR-derived title silently leaves otherwise eligible candidates unchecked.
  it("checks every retrieved candidate concurrently using stable name and identifier inputs", async () => {
    for (let index = 0; index < 21; index++)
      await createProductFixture(
        ctx.db,
        makeProductInput({
          name: `Synthetic Forge canvas boot blue ${index}`,
          manufacturer: "Synthetic Forge",
        }),
        ctx.actor,
      );
    let compared = 0;
    const matches = await queryPhotoProductCandidates(
      ctx.db,
      {
        name: "Synthetic Forge canvas boot blue",
        manufacturer: "Synthetic Forge",
        evidenceTexts: [
          {
            source: "label_ocr",
            text: `${"Unrelated prose ".repeat(100)} FW-7744`,
          },
        ],
      },
      ctx.actor,
      async ({ comparisons }) => {
        compared = comparisons.length;
        expect(
          comparisons.every(
            (pair) =>
              pair.firstTitle === "Synthetic Forge canvas boot blue\nFW-7744",
          ),
        ).toBe(true);
        return comparisons.map((pair) => ({
          color: { relation: "unknown" },
          size: { relation: "unknown" },
          evidence: pair,
        }));
      },
    );
    expect(compared).toBe(21);
    expect(matches).toHaveLength(20);
    expect(
      matches.every((candidate) => candidate.duplicateStrength === "strong"),
    ).toBe(true);
  });

  // Selected evidence cannot depend on lexical retrieval or a successful inference.
  it("reads selected Product dates, vendor and capture time independently of ranking", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic selected object" }),
      ctx.actor,
    );
    const place = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic evidence shelf",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: place.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic history store",
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-08-03",
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: order.id,
      productId: item.entityId,
      name: "Synthetic ordered line",
      date: "2026-09-04",
      cost: 42,
      productQuantity: 1,
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
    });
    await insertWithShortcode(ctx.db, "expense", {
      productId: item.entityId,
      name: "Synthetic paid line",
      date: "2026-08-02",
      cost: 21,
      productQuantity: 1,
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
    });
    const photo = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}-selected.jpg`,
      filename: "synthetic-selected.jpg",
      contentType: "image/jpeg",
      size: 100,
      source: "own",
    });
    await getDb(ctx.db)
      .update(image)
      .set({ capturedAt: new Date("2026-08-04T18:00:00.000Z") })
      .where(eq(image.id, photo.id));
    await insertEntityAttachments(ctx.db, {
      entityId: item.entityId,
      imageId: photo.id,
    });
    const evidence = (
      await loadPhotoProductEvidence(ctx.db, [item.entityId], ctx.actor)
    ).get(item.entityId);
    expect(evidence?.purchaseLines).toEqual([
      expect.objectContaining({
        name: "Synthetic ordered line",
        date: "2026-08-03",
        dateLabel: "Ordered",
        vendor: "Synthetic history store",
        cost: 42,
      }),
      expect.objectContaining({
        name: "Synthetic paid line",
        date: "2026-08-02",
        dateLabel: "Paid",
        vendor: null,
        cost: 21,
      }),
    ]);
    expect(evidence?.purchaseLineCount).toBe(2);
    expect(evidence?.ownPhotos).toEqual([
      expect.objectContaining({ capturedAt: "2026-08-04T18:00:00.000Z" }),
    ]);
    expect(evidence?.quantity?.onHandUnits).toBe(2);
    expect(evidence?.inventoryEntries).toEqual([
      expect.objectContaining({
        location: expect.objectContaining({ name: "Synthetic evidence shelf" }),
      }),
    ]);
  });

  it("exposes only known accepted line selectors owned by the reviewing member", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic candidate reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic Outfit canvas shirt blue medium",
        manufacturer: "Synthetic Outfit",
      }),
      ctx.actor,
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic outfit retailer",
    });
    await memberImport(ctx.db, ctx.actor, {
      key: "synthetic-photo-candidate-source",
      orders: [
        {
          stableOrderId: "synthetic-photo-candidate-source",
          vendorId: vendor.shortcode,
          source: {
            kind: "receipt_photo",
            externalKey: "synthetic:candidate-source",
            checksum: "a".repeat(64),
          },
          extraction: {
            status: "ready",
            candidate: {
              orderId: "SYNTHETIC-CANDIDATE",
              orderedAt: "2026-09-01T18:00:00Z",
              merchant: "Synthetic outfit retailer",
              currency: "USD",
              printedGrandTotal: 40,
              lines: [
                {
                  title: item.name,
                  amount: 40,
                  quantity: 2,
                  lineKind: "principal",
                },
              ],
              payments: [{ amount: 40 }],
              allShipmentsDelivered: true,
            },
          },
          resolutions: [{ kind: "existing", productId: item.id }],
        },
      ],
    });
    const association = await getDb(ctx.db).query.importSourceOrder.findFirst();
    const line = await getDb(ctx.db).query.expense.findFirst();
    if (!association?.acceptedObservationId || !line)
      throw new Error("Known accepted fixture missing");
    const input = { name: item.name, manufacturer: "Synthetic Outfit" };
    const [known] = await findPhotoProductCandidates(ctx.db, input, ctx.actor);
    expect(known?.purchaseLines).toContainEqual(
      expect.objectContaining({
        expenseId: line.shortcode,
        acceptedSourceLines: [{ sourceOrderId: association.id, lineIndex: 0 }],
      }),
    );
    const otherReviewer = userId.parse(crypto.randomUUID());
    await getDb(ctx.db).insert(user).values({
      id: otherReviewer,
      name: "Other reviewer",
      email: "other-reviewer@synthetic.invalid",
      emailVerified: true,
    });
    const [otherMember] = await findPhotoProductCandidates(ctx.db, input, {
      ...ctx.actor,
      userId: otherReviewer,
    });
    expect(
      otherMember?.purchaseLines?.every(
        (row) => !row.acceptedSourceLines?.length,
      ),
    ).toBe(true);
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ acceptedObservationId: null, originalOrder: null })
      .where(eq(importSourceOrder.id, association.id));
    const [unknown] = await findPhotoProductCandidates(
      ctx.db,
      input,
      ctx.actor,
    );
    expect(
      unknown?.purchaseLines?.every((row) => !row.acceptedSourceLines?.length),
    ).toBe(true);
  });

  it("keeps accepted photo line selectors discoverable across Purchase and Vendor merges without rewriting original evidence", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic merge reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic Outfit canvas shirt blue medium",
        manufacturer: "Synthetic Outfit",
      }),
      ctx.actor,
    );
    const originalVendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic original retailer",
    });
    await memberImport(ctx.db, ctx.actor, {
      key: "synthetic-photo-merge-source",
      orders: [
        {
          stableOrderId: "synthetic-photo-merge-source",
          vendorId: originalVendor.shortcode,
          source: {
            kind: "receipt_photo",
            externalKey: "synthetic:photo-merge-source",
            checksum: "d".repeat(64),
          },
          extraction: {
            status: "ready",
            candidate: {
              orderId: "SYNTHETIC-MERGE",
              orderedAt: "2026-09-01T18:00:00Z",
              merchant: "Synthetic original retailer",
              currency: "USD",
              printedGrandTotal: 40,
              lines: [
                {
                  title: item.name,
                  amount: 40,
                  quantity: 2,
                  lineKind: "principal",
                },
              ],
              payments: [{ amount: 40 }],
              allShipmentsDelivered: true,
            },
          },
          resolutions: [{ kind: "existing", productId: item.id }],
        },
      ],
    });
    const association = await getDb(ctx.db).query.importSourceOrder.findFirst();
    const originalPurchase = await getDb(ctx.db).query.purchase.findFirst();
    const line = await getDb(ctx.db).query.expense.findFirst();
    if (!association?.acceptedObservationId || !originalPurchase || !line)
      throw new Error("Synthetic accepted merge fixture missing");
    const [originalEvidence] = await getDb(ctx.db)
      .select()
      .from(sourceOrderObservation)
      .where(eq(sourceOrderObservation.id, association.acceptedObservationId));
    const keeper = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: originalVendor.id,
    });
    await mergePurchases(
      ctx.db,
      {
        keepId: keeper.shortcode,
        mergeIds: [parseShortcodeFor("purchase", originalPurchase.shortcode)],
      },
      ctx.actor,
    );
    const keeperVendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic keeper retailer",
    });
    await mergeVendors(
      ctx.db,
      {
        keepId: parseShortcodeFor("vendor", keeperVendor.shortcode),
        mergeIds: [parseShortcodeFor("vendor", originalVendor.shortcode)],
      },
      ctx.actor,
    );
    const [candidate] = await findPhotoProductCandidates(
      ctx.db,
      { name: item.name, manufacturer: "Synthetic Outfit" },
      ctx.actor,
    );
    expect(candidate?.purchaseLines).toContainEqual(
      expect.objectContaining({
        expenseId: line.shortcode,
        purchaseId: keeper.shortcode,
        acceptedSourceLines: [{ sourceOrderId: association.id, lineIndex: 0 }],
      }),
    );
    const [unchanged] = await getDb(ctx.db)
      .select()
      .from(sourceOrderObservation)
      .where(eq(sourceOrderObservation.id, association.acceptedObservationId));
    expect(unchanged).toEqual(originalEvidence);
    expect(unchanged).toMatchObject({
      purchaseId: originalPurchase.id,
      vendorId: originalVendor.id,
    });
    const unknown = await getDb(ctx.db).query.importSourceOrder.findFirst();
    expect(unknown).toMatchObject({
      id: association.id,
      purchaseId: keeper.id,
      acceptedObservationId: association.acceptedObservationId,
    });
  });

  it("returns existing variants and their own-photo provenance", async () => {
    const clean = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "ForgeWear pocket tee black small",
        manufacturer: "ForgeWear",
      }),
      ctx.actor,
    );
    const photographed = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "ForgeWear pocket tee black small duplicate",
        manufacturer: "ForgeWear",
      }),
      ctx.actor,
    );
    const photo = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}-own.jpg`,
      filename: "own.jpg",
      contentType: "image/jpeg",
      size: 100,
      source: "own",
    });
    await insertEntityAttachments(ctx.db, {
      entityId: photographed.entityId,
      imageId: photo.id,
    });

    const matches = await findPhotoProductCandidates(
      ctx.db,
      {
        name: "ForgeWear pocket tee black small",
        manufacturer: "ForgeWear",
      },
      ctx.actor,
    );
    expect(matches[0]?.id).toBe(clean.id);
    expect(matches[0]?.match).toMatchObject({
      source: "catalog_name",
      sharedNameTerms: ["pocket", "tee", "black", "small"],
      brandMatches: true,
      variant: {
        color: { relation: "unknown" },
        size: { relation: "unknown" },
        evidence: {
          firstTitle: "ForgeWear pocket tee black small",
          secondTitle: expect.stringContaining(clean.name),
        },
      },
    });
    expect(
      matches.find((item) => item.id === photographed.id)?.hasOwnPhoto,
    ).toBe(true);
    expect(matches[0]?.quantity).toMatchObject({
      onHandUnits: null,
      quantityLedger: { expectedQuantity: 0 },
    });
    expect(matches[0]?.inventoryEntries).toEqual([]);
    expect(
      matches.find((item) => item.id === photographed.id)?.ownPhotos?.length,
    ).toBe(1);
  });

  it("finds an alias and an exact identifier observed on a label", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "ForgeWear Q7",
        manufacturer: "ForgeWear",
        aliases: ["work boots"],
      }),
      ctx.actor,
    );
    await ensureExternalSources(ctx.db, ["synthetic"]);
    await getDb(ctx.db)
      .insert(entityExternalId)
      .values({
        entityId: item.entityId,
        entityKind: "product" as const,
        source: "synthetic",
        kind: "retailer_sku",
        externalId: "FW-7744",
        isPrimary: true,
      });
    const alias = await findPhotoProductCandidates(
      ctx.db,
      {
        name: "ForgeWear work boots",
        manufacturer: "ForgeWear",
      },
      ctx.actor,
    );
    expect(alias.some((candidate) => candidate.id === item.id)).toBe(true);
    const exact = await findPhotoProductCandidates(
      ctx.db,
      {
        name: "Unidentified footwear",
        evidenceTexts: [{ source: "label_ocr", text: "SKU FW-7744" }],
      },
      ctx.actor,
    );
    expect(exact[0]?.id).toBe(item.id);
    expect(exact[0]?.match.matchedIdentifiers).toEqual(["FW-7744"]);
    expect(exact[0]?.match.factors).toContainEqual({
      label: "Exact external identifier",
      points: expect.any(Number),
    });
  });

  it("shows returned, concession, and unknown-quantity lines without claiming the photo is absent", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "ForgeWear tan work boots",
        manufacturer: "ForgeWear",
      }),
      ctx.actor,
    );
    for (const [name, cost, productQuantity] of [
      ["Boot purchase", 120, 2],
      ["Boot return", -60, 1],
      ["Price concession", -10, 0],
      ["Unspecified refund", -20, null],
    ] as const) {
      await insertWithShortcode(ctx.db, "expense", {
        name,
        cost,
        productQuantity,
        productId: item.entityId,
        date: "2026-01-05",
        costType: "materials",
        trade: "other",
        lineKind: "principal",
        lineBasis: "item_line",
      });
    }
    const [candidate] = await findPhotoProductCandidates(
      ctx.db,
      {
        name: "ForgeWear tan work boots",
        manufacturer: "ForgeWear",
      },
      ctx.actor,
    );
    expect(candidate?.quantity?.quantityLedger).toMatchObject({
      expectedQuantity: 1,
      acquiredUnits: 2,
      exitedUnits: 1,
      unknownExitLines: 1,
    });
    expect(
      candidate?.purchaseLines?.map((line) => [line.name, line.movement]),
    ).toEqual(
      expect.arrayContaining([
        ["Boot return", "exited"],
        ["Price concession", "adjusted"],
        ["Unspecified refund", "unknown"],
      ]),
    );
  });
});
