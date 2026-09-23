import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { taxonomyId } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  aiAnalysis,
  entityAttachment,
  image,
  imageDescriptionCorrection,
  imageProcessingJob,
  productCategory,
} from "~/server/db/schema";

import { getDb } from "../database-helpers";
import { createUploadedImageRecord } from "../image";
import { persistImageProcessingSubmission } from "../image-processing-submission";
import { insertWithShortcode } from "../shortcode-utils";
import { getProductClassificationEvidence } from "./classification-evidence";

const ctx = withTestDb();
describe("retained classification evidence", () => {
  it("schedules an item cutout but leaves labels available for original analysis only", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic item",
      manufacturer: "Example",
    });
    const item = await createUploadedImageRecord(ctx.db, {
      key: "tests/cutout-item.jpg",
      filename: "item.jpg",
      contentType: "image/jpeg",
      size: 64,
    });
    const label = await createUploadedImageRecord(ctx.db, {
      key: "tests/cutout-label.jpg",
      filename: "label.jpg",
      contentType: "image/jpeg",
      size: 64,
    });
    for (const source of [item, label])
      await getDb(ctx.db)
        .update(image)
        .set({ sha256: "a".repeat(64) })
        .where(eq(image.id, source.id));
    await getDb(ctx.db)
      .insert(entityAttachment)
      .values([
        { subjectEntityId: product.id, imageId: item.id, purpose: "item" },
        { subjectEntityId: product.id, imageId: label.id, purpose: "label" },
      ]);
    const itemJobs = await persistImageProcessingSubmission(ctx.db, {
      id: item.shortcode,
      kinds: ["subject_lift"],
      automatic: true,
    });
    const labelJobs = await persistImageProcessingSubmission(ctx.db, {
      id: label.shortcode,
      kinds: ["subject_lift", "describe_image"],
      automatic: true,
    });
    expect(itemJobs.jobIds).toHaveLength(1);
    expect(labelJobs.jobIds).toHaveLength(1);
    expect(
      (
        await getDb(ctx.db)
          .select({ kind: imageProcessingJob.kind })
          .from(imageProcessingJob)
          .where(
            eq(imageProcessingJob.imageId, parseEntityId("image", label.id)),
          )
      ).map((row) => row.kind),
    ).toEqual(["describe_image"]);
    // Purpose belongs to the attachment. A second Product may legitimately
    // use the same original as an item; that use still permits a rendition.
    const secondProduct = await insertWithShortcode(ctx.db, "product", {
      name: "Shared original item",
      manufacturer: "Example",
    });
    await getDb(ctx.db).insert(entityAttachment).values({
      subjectEntityId: secondProduct.id,
      imageId: label.id,
      purpose: "item",
    });
    const sharedJobs = await persistImageProcessingSubmission(ctx.db, {
      id: label.shortcode,
      kinds: ["subject_lift"],
      automatic: true,
    });
    expect(sharedJobs.jobIds).toHaveLength(1);
  });

  it("uses original descriptions and confirmed label corrections, refreshes taxonomy evidence, and never schedules vision on read", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic jacket",
      manufacturer: "Example",
      categoryId: taxonomyId("apparel"),
    });
    const photo = await createUploadedImageRecord(ctx.db, {
      key: "tests/item-original.jpg",
      filename: "item.jpg",
      contentType: "image/jpeg",
      size: 64,
    });
    const label = await createUploadedImageRecord(ctx.db, {
      key: "tests/label-original.jpg",
      filename: "label.jpg",
      contentType: "image/jpeg",
      size: 64,
    });
    await getDb(ctx.db)
      .insert(entityAttachment)
      .values([
        {
          subjectEntityId: product.id,
          imageId: photo.id,
          purpose: "item",
          sortOrder: 0,
        },
        {
          subjectEntityId: product.id,
          imageId: label.id,
          purpose: "label",
          sortOrder: 1,
        },
      ]);
    await getDb(ctx.db)
      .insert(aiAnalysis)
      .values([
        {
          entityType: "image",
          entityId: photo.id,
          feature: "image-description",
          model: "synthetic",
          promptVersion: "test",
          inputFingerprint: "original-item",
          result: { description: "Blue jacket with long sleeves" },
        },
        {
          entityType: "image",
          entityId: label.id,
          feature: "image-description",
          model: "synthetic",
          promptVersion: "test",
          inputFingerprint: "original-label",
          result: { description: "Uncertain fabric lettering" },
        },
      ]);
    await getDb(ctx.db)
      .insert(imageDescriptionCorrection)
      .values({
        imageId: parseEntityId("image", label.id),
        description: "Label confirms 100% cotton",
      });
    const before = await getProductClassificationEvidence(ctx.db, product.id);
    expect(before).toContain("item: Blue jacket with long sleeves");
    expect(before).toContain(
      "label: Label confirms 100% cotton [confirmed correction]",
    );
    expect(before).not.toContain("Uncertain fabric lettering");
    await getDb(ctx.db)
      .update(productCategory)
      .set({ name: "Wearables", updatedAt: new Date(Date.now() + 1000) })
      .where(eq(productCategory.id, taxonomyId("apparel")));
    expect(await getProductClassificationEvidence(ctx.db, product.id)).not.toBe(
      before,
    );
    expect(await getDb(ctx.db).select().from(imageProcessingJob)).toEqual([]);
  });
});
