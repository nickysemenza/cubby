import {
  type ImageId,
  parseEntityId,
  productShortcode,
} from "@cubby/schemas/identifiers";
import {
  imageIdentificationResult,
  IMAGE_IDENTIFICATION_MODEL,
  IMAGE_IDENTIFICATION_PROMPT_REVISION,
  IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
  type ImageIdentificationResult,
} from "@cubby/schemas/image-identification";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  ne,
  or,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import {
  repositoryQueries as getDb,
  repositoryQueries as unwrapDb,
} from "~/server/db/repository-access.boundary";
import {
  aiAnalysis,
  entityAttachment,
  image,
  imageProcessingAttempt,
  imageProcessingJob,
  product,
  productCategory,
} from "~/server/db/retained-tables";

const fingerprintSchema = z.object({
  sourceContentHash: z.string(),
  feature: z.literal("image-identification"),
});

type RetainedIdentification = {
  result: ImageIdentificationResult;
  createdAt: Date;
};

/** Two batched reads; historical suggestions cannot survive replaced sources or deleted targets. */
async function loadCurrentIdentifications(
  db: Database | DrizzleTransaction,
  scope: SQL,
) {
  const rows = await unwrapDb(db)
    .select({
      shortcode: image.shortcode,
      result: aiAnalysis.result,
      fingerprint: aiAnalysis.inputFingerprint,
      hash: image.sha256,
      createdAt: aiAnalysis.createdAt,
    })
    .from(aiAnalysis)
    .innerJoin(image, eq(image.id, aiAnalysis.entityId))
    .where(
      and(
        scope,
        notDeleted(image),
        eq(image.status, "UPLOADED"),
        notDeleted(aiAnalysis),
        eq(aiAnalysis.entityKind, "image"),
        eq(aiAnalysis.feature, "image-identification"),
        eq(aiAnalysis.provider, "cloudflare"),
        eq(aiAnalysis.model, IMAGE_IDENTIFICATION_MODEL),
        eq(
          aiAnalysis.promptVersion,
          String(IMAGE_IDENTIFICATION_PROMPT_REVISION),
        ),
        eq(
          aiAnalysis.resultSchemaRevision,
          IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
        ),
      ),
    )
    .orderBy(desc(aiAnalysis.createdAt));
  const current = new Map<string, RetainedIdentification>();
  for (const row of rows) {
    if (current.has(row.shortcode)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(row.fingerprint);
    } catch {
      // SILENT: Historical malformed observations are ineligible for reuse.
      continue;
    }
    const fingerprint = fingerprintSchema.safeParse(raw);
    const result = imageIdentificationResult.safeParse(row.result);
    if (
      !fingerprint.success ||
      fingerprint.data.sourceContentHash !== row.hash ||
      !result.success
    )
      continue;
    current.set(row.shortcode, {
      result: result.data,
      createdAt: row.createdAt,
    });
  }
  const ids = [
    ...new Set(
      [...current.values()].flatMap(({ result }) =>
        result.candidates.map((candidate) => candidate.productId),
      ),
    ),
  ];
  const live = ids.length
    ? await unwrapDb(db)
        .select({ code: product.shortcode, name: product.name })
        .from(product)
        .where(and(inArray(product.shortcode, ids), notDeleted(product)))
    : [];
  const byCode = new Map(live.map((entry) => [entry.code, entry.name]));
  for (const entry of current.values()) {
    entry.result.candidates = entry.result.candidates.flatMap((candidate) => {
      const name = byCode.get(candidate.productId);
      return name === undefined ? [] : [{ ...candidate, name }];
    });
    if (
      entry.result.outcome === "suggestions" &&
      !entry.result.candidates.length
    )
      entry.result.outcome = "no_candidates";
  }
  return current;
}

export async function readImageIdentification(
  db: Database | DrizzleTransaction,
  imageId: ImageId,
) {
  const rows = await loadCurrentIdentifications(db, eq(image.id, imageId));
  return rows.values().next().value ?? null;
}

export async function loadImageIdentifications(
  db: Database | DrizzleTransaction,
  imageShortcodes: readonly string[],
): Promise<Map<string, RetainedIdentification>> {
  if (!imageShortcodes.length) return new Map();
  return loadCurrentIdentifications(
    db,
    inArray(image.shortcode, [...new Set(imageShortcodes)]),
  );
}

/** Retrieval is explicit and bounded; only categories with live Products participate. */
export async function imageIdentificationCategories(db: Database) {
  return getDb(db)
    .select({ id: productCategory.id, name: productCategory.name })
    .from(productCategory)
    .where(
      and(
        notDeleted(productCategory),
        sql`EXISTS (SELECT 1 FROM "Product" p WHERE p."categoryId" = ${productCategory.id} AND p."deletedAt" IS NULL)`,
      ),
    )
    .orderBy(asc(productCategory.name), asc(productCategory.id))
    .limit(201);
}

/** Direct Product evidence only: no borrowed image and no self-comparison by id or bytes. */
export async function imageIdentificationCandidates(
  db: Database,
  input: {
    imageId: ImageId;
    sourceHash: string;
    categoryId: string | null;
    preferredIds: readonly string[];
  },
) {
  const preferred = input.preferredIds.length
    ? inArray(
        product.id,
        input.preferredIds.map((id) => parseEntityId("product", id)),
      )
    : sql`false`;
  const scope = input.categoryId
    ? sql`(${product.categoryId} = ${input.categoryId}::uuid OR ${preferred})`
    : preferred;
  const products = await getDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      updatedAt: product.updatedAt,
    })
    .from(product)
    .where(and(notDeleted(product), scope))
    .orderBy(
      sql`CASE WHEN ${preferred} THEN 0 ELSE 1 END`,
      asc(product.name),
      asc(product.id),
    )
    .limit(41);
  const selected = products.slice(0, 40);
  const references = selected.length
    ? await getDb(db)
        .select({
          productId: entityAttachment.entityId,
          key: image.key,
          hash: image.sha256,
          updatedAt: image.updatedAt,
        })
        .from(entityAttachment)
        .innerJoin(image, eq(image.id, entityAttachment.imageId))
        .where(
          and(
            inArray(
              entityAttachment.entityId,
              selected.map((entry) => entry.id),
            ),
            notDeleted(entityAttachment),
            notDeleted(image),
            eq(image.status, "UPLOADED"),
            ne(image.id, input.imageId),
            ne(image.sha256, input.sourceHash),
            or(
              isNull(entityAttachment.purpose),
              eq(entityAttachment.purpose, "item"),
            ),
            ne(image.contentType, "application/pdf"),
            ne(image.contentType, "image/avif"),
          ),
        )
        .orderBy(asc(entityAttachment.sortOrder), asc(image.id))
    : [];
  const first = new Map<string, (typeof references)[number]>();
  for (const reference of references)
    if (!first.has(reference.productId))
      first.set(reference.productId, reference);
  return {
    truncated: products.length > 40,
    candidates: selected.map((entry) => ({
      productId: productShortcode.parse(entry.shortcode),
      name: entry.name,
      updatedAt: entry.updatedAt.toISOString(),
      imageUrl: first.has(entry.id)
        ? getR2PublicUrl(first.get(entry.id)!.key)
        : null,
      imageHash: first.get(entry.id)?.hash ?? null,
    })),
  };
}

const retainedRendition = z.object({
  sourceHash: z.string(),
  renditionKey: z.string(),
  renditionHash: z.string().regex(/^[a-f0-9]{64}$/),
  normalizationRevision: z.literal(1),
});

/** Reuse only a server-owned JPEG snapshot already verified for the current source. */
export async function getVerifiedImageRenditionKey(
  db: Database,
  imageId: ImageId,
): Promise<string | null> {
  const attempts = await getDb(db)
    .select({
      key: imageProcessingAttempt.inputKey,
      diagnostics: imageProcessingAttempt.diagnostics,
      hash: image.sha256,
    })
    .from(imageProcessingAttempt)
    .innerJoin(
      imageProcessingJob,
      eq(imageProcessingJob.id, imageProcessingAttempt.jobId),
    )
    .innerJoin(image, eq(image.id, imageProcessingJob.imageId))
    .where(
      and(
        eq(image.id, imageId),
        notDeleted(image),
        eq(image.status, "UPLOADED"),
        eq(imageProcessingJob.kind, "describe_image"),
        eq(imageProcessingJob.sourceContentHash, image.sha256),
      ),
    )
    .orderBy(desc(imageProcessingAttempt.startedAt));
  for (const attempt of attempts) {
    const parsed = retainedRendition.safeParse(attempt.diagnostics);
    if (
      parsed.success &&
      parsed.data.sourceHash === attempt.hash &&
      parsed.data.renditionKey === attempt.key
    )
      return attempt.key;
  }
  return null;
}
