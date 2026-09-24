import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityAttachment } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createUploadedImageRecord } from "~/server/repo/image";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

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
    expect(matches[0]?.match).toEqual({
      source: "catalog_name",
      sharedNameTerms: ["pocket", "tee", "black", "small"],
      brandMatches: true,
    });
    expect(
      matches.find((item) => item.id === photographed.id)?.hasOwnPhoto,
    ).toBe(true);
  });
});
