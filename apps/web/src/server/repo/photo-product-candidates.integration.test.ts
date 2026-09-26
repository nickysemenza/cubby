import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityAttachment, productExternalId } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createUploadedImageRecord } from "~/server/repo/image";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { findPhotoProductCandidates } from "./photo-product-candidates";

describe("photo product candidates", () => {
  const ctx = withTestDb();

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
    await getDb(ctx.db).insert(entityAttachment).values({
      subjectEntityId: photographed.entityId,
      imageId: photo.id,
    });

    const matches = await findPhotoProductCandidates(ctx.db, {
      name: "ForgeWear pocket tee black small",
      manufacturer: "ForgeWear",
    });
    expect(matches[0]?.id).toBe(clean.id);
    expect(matches[0]?.match).toMatchObject({
      source: "catalog_name",
      sharedNameTerms: ["pocket", "tee", "black", "small"],
      brandMatches: true,
      variant: {
        color: { first: "Black", second: "Black", relation: "same" },
        size: { first: "Small", second: "Small", relation: "same" },
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
    await getDb(ctx.db).insert(productExternalId).values({
      productId: item.entityId,
      source: "synthetic",
      kind: "sku",
      externalId: "FW-7744",
    });
    const alias = await findPhotoProductCandidates(ctx.db, {
      name: "ForgeWear work boots",
      manufacturer: "ForgeWear",
    });
    expect(alias.some((candidate) => candidate.id === item.id)).toBe(true);
    const exact = await findPhotoProductCandidates(ctx.db, {
      name: "Unidentified footwear",
      evidenceTexts: [{ source: "label_ocr", text: "SKU FW-7744" }],
    });
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
    const [candidate] = await findPhotoProductCandidates(ctx.db, {
      name: "ForgeWear tan work boots",
      manufacturer: "ForgeWear",
    });
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
