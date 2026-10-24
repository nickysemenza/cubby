import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { taxonomyId } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  aiAnalysis,
  image,
  imageProcessingJob,
  productCategory,
  product as productTable,
} from "~/server/db/schema";
import { persistImageProcessingSubmission } from "~/server/domains/image-processing/repo/image-processing-submission";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { insertEntityAttachments } from "~/server/testing/repo.fixtures";

import {
  getProductClassificationEvidence,
  productClassificationEvidenceSql,
} from "./product-classification-evidence";

const ctx = withTestDb();
describe("retained classification evidence", () => {
  it("schedules subject lift for item and label images and reuses shared jobs", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic item",
      brandId: await findOrCreateVendor(ctx.db, "Example"),
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
    await insertEntityAttachments(ctx.db, [
      { entityId: product.id, imageId: item.id, purpose: "item" },
      { entityId: product.id, imageId: label.id, purpose: "label" },
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
    expect(labelJobs.jobIds).toHaveLength(3);
    expect(
      (
        await getDb(ctx.db)
          .select({ kind: imageProcessingJob.kind })
          .from(imageProcessingJob)
          .where(
            eq(imageProcessingJob.imageId, parseEntityId("image", label.id)),
          )
      )
        .map((row) => row.kind)
        .sort(),
    ).toEqual(["describe_image", "describe_image", "subject_lift"]);
    // Purpose belongs to the attachment. A second Product may legitimately
    // use the same original as an item; that use still permits a rendition.
    const secondProduct = await insertWithShortcode(ctx.db, "product", {
      name: "Shared original item",
      brandId: await findOrCreateVendor(ctx.db, "Example"),
    });
    await insertEntityAttachments(ctx.db, {
      entityId: secondProduct.id,
      imageId: label.id,
      purpose: "item",
    });
    const sharedJobs = await persistImageProcessingSubmission(ctx.db, {
      id: label.shortcode,
      kinds: ["subject_lift"],
      automatic: true,
    });
    expect(sharedJobs.jobIds).toHaveLength(1);
    expect(labelJobs.jobIds).toContain(sharedJobs.jobIds[0]);
  });

  it("uses original descriptions and confirmed label corrections, refreshes taxonomy evidence, and never schedules vision on read", async () => {
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic jacket",
      brandId: await findOrCreateVendor(ctx.db, "Example"),
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
    for (const source of [photo, label])
      await getDb(ctx.db)
        .update(image)
        .set({ sha256: "a".repeat(64) })
        .where(eq(image.id, source.id));
    await insertEntityAttachments(ctx.db, [
      {
        entityId: product.id,
        imageId: photo.id,
        purpose: "item",
        sortOrder: 0,
      },
      {
        entityId: product.id,
        imageId: label.id,
        purpose: "label",
        sortOrder: 1,
      },
    ]);
    await getDb(ctx.db)
      .insert(aiAnalysis)
      .values([
        {
          entityKind: "image",
          entityId: photo.id,
          feature: "image-description",
          model: "synthetic",
          promptVersion: "test",
          inputFingerprint: JSON.stringify({
            sourceContentHash: "a".repeat(64),
          }),
          result: { description: "Blue jacket with long sleeves" },
        },
        {
          entityKind: "image",
          entityId: label.id,
          feature: "image-description",
          model: "synthetic",
          promptVersion: "test",
          inputFingerprint: JSON.stringify({
            sourceContentHash: "a".repeat(64),
          }),
          result: { description: "Uncertain fabric lettering" },
        },
      ]);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      standalone: { kind: "image_description", id: label.shortcode },
      operationId: crypto.randomUUID(),
      verdict: "correct",
      correction: { present: true, value: "Label confirms 100% cotton" },
      intent: "apply",
    });
    const before = await getProductClassificationEvidence(ctx.db, product.id);
    expect(before).toContain("item: Blue jacket with long sleeves");
    expect(before).toContain(
      "label: Label confirms 100% cotton [confirmed correction]",
    );
    expect(before).not.toContain("Uncertain fabric lettering");
    // Relational extras rewrite column chunks to the outer Product alias.
    // The nested confirmation proof must preserve its own table references.
    const relational = await getDb(ctx.db).query.product.findFirst({
      where: eq(productTable.id, product.id),
      columns: { id: true },
      extras: {
        classificationEvidence: productClassificationEvidenceSql(
          sql`${productTable.id}`,
        ).as("classificationEvidence"),
      },
    });
    expect(relational?.classificationEvidence).toBe(before);

    await getDb(ctx.db)
      .update(productCategory)
      .set({ name: "Wearables", updatedAt: new Date(Date.now() + 1000) })
      .where(eq(productCategory.id, taxonomyId("apparel")));
    expect(await getProductClassificationEvidence(ctx.db, product.id)).not.toBe(
      before,
    );
    expect(await getDb(ctx.db).select().from(imageProcessingJob)).toEqual([]);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, label.id));
    const changed = await getProductClassificationEvidence(ctx.db, product.id);
    expect(changed).not.toContain("Label confirms 100% cotton");
    expect(changed).not.toContain("Uncertain fabric lettering");
    expect(changed).toContain("Blue jacket with long sleeves");
  });
});
