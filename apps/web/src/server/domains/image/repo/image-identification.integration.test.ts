import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  IMAGE_IDENTIFICATION_MODEL,
  IMAGE_IDENTIFICATION_PROMPT_REVISION,
  IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-identification";
import { rawImageDetail } from "@cubby/schemas/image-raw-read";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { withDatabaseOperationMetrics } from "~/server/db/db-observability";
import { getDb } from "~/server/db/helpers";
import {
  aiAnalysis,
  entityAttachment,
  image,
  product,
} from "~/server/db/schema";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { createUploadedImageRecord, imageScaffold } from "./image";
import {
  loadImageIdentifications,
  readImageIdentification,
  imageIdentificationCategories,
  imageIdentificationCandidates,
} from "./image-identification";

// Retained suggestions must not leak replaced sources or deleted catalog targets into pages.
const ctx = withTestDb();
it("batches current observations and removes deleted targets and replaced sources", async () => {
  const target = await insertWithShortcode(ctx.db, "product", {
    name: "Synthetic blue drill",
    brandId: await findOrCreateVendor(ctx.db, "Synthetic"),
    kind: "durable",
  });
  const source = await createUploadedImageRecord(ctx.db, {
    key: `tests/${crypto.randomUUID()}.jpg`,
    filename: "sample.jpg",
    contentType: "image/jpeg",
    size: 512,
  });
  const hash = "a".repeat(64);
  await getDb(ctx.db)
    .update(image)
    .set({ sha256: hash })
    .where(eq(image.id, source.id));
  await getDb(ctx.db)
    .insert(aiAnalysis)
    .values({
      entityKind: "image",
      entityId: source.id,
      feature: "image-identification",
      provider: "cloudflare",
      model: IMAGE_IDENTIFICATION_MODEL,
      promptVersion: String(IMAGE_IDENTIFICATION_PROMPT_REVISION),
      resultSchemaRevision: IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
      inputFingerprint: JSON.stringify({
        feature: "image-identification",
        sourceContentHash: hash,
      }),
      result: {
        subject: "single_object",
        category: "Tools",
        outcome: "suggestions",
        candidates: [
          {
            productId: target.shortcode,
            name: "Synthetic drill",
            probability: 0.8,
          },
        ],
        considered: 1,
        truncated: false,
      },
    });
  expect(
    (await loadImageIdentifications(ctx.db, [source.shortcode])).get(
      source.shortcode,
    )?.result.candidates,
  ).toEqual([
    { productId: target.shortcode, name: target.name, probability: 0.8 },
  ]);
  // Warm the bounded test pool so connection startup does not split concurrent read intervals.
  await Promise.all(
    Array.from({ length: 10 }, () => getDb(ctx.db).execute(sql`SELECT 1`)),
  );
  await withDatabaseOperationMetrics(async (metrics) => {
    const page = await imageScaffold.read(ctx.db, {
      filters: {},
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 25 },
    });
    const listed = page.data
      .map((row) => rawImageDetail.parse(row))
      .find((row) => row.id === source.shortcode);
    expect(listed?.analysisSummary?.identification?.candidates).toEqual([
      { productId: target.shortcode, name: target.name, probability: 0.8 },
    ]);
    expect(metrics.queryCount).toBeGreaterThan(0);
    expect(metrics.queryBusyIntervals).toBeLessThanOrEqual(2);
  });
  await getDb(ctx.db)
    .update(product)
    .set({ deletedAt: new Date() })
    .where(eq(product.id, target.id));
  expect(
    (await readImageIdentification(ctx.db, parseEntityId("image", source.id)))
      ?.result,
  ).toMatchObject({ outcome: "no_candidates", candidates: [] });
  await getDb(ctx.db)
    .update(image)
    .set({ sha256: "b".repeat(64) })
    .where(eq(image.id, source.id));
  expect(await loadImageIdentifications(ctx.db, [source.shortcode])).toEqual(
    new Map(),
  );
});

it("retrieves a live category and never compares the source against itself", async () => {
  const category = await insertWithShortcode(ctx.db, "productCategory", {
    name: "Synthetic tools",
  });
  const target = await insertWithShortcode(ctx.db, "product", {
    name: "Synthetic drill",
    brandId: await findOrCreateVendor(ctx.db, "Synthetic"),
    categoryId: category.id,
  });
  const source = await createUploadedImageRecord(ctx.db, {
    key: `tests/${crypto.randomUUID()}.jpg`,
    filename: "sample.jpg",
    contentType: "image/jpeg",
    size: 512,
  });
  const hash = "a".repeat(64);
  await getDb(ctx.db)
    .update(image)
    .set({ sha256: hash })
    .where(eq(image.id, source.id));
  await getDb(ctx.db).insert(entityAttachment).values({
    entityKind: "product",
    entityId: target.id,
    imageId: source.id,
    purpose: "item",
  });
  expect(await imageIdentificationCategories(ctx.db)).toContainEqual({
    id: category.id,
    name: category.name,
  });
  const result = await imageIdentificationCandidates(ctx.db, {
    imageId: parseEntityId("image", source.id),
    sourceHash: hash,
    categoryId: category.id,
    preferredIds: [],
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    productId: target.shortcode,
    imageUrl: null,
  });
});
