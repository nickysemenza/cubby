import { aiProvenance, type AiProvenance } from "@cubby/schemas/ai-evaluation";
import { productId, runEntityId, type RunId } from "@cubby/schemas/identifiers";
import type { ProductId } from "@cubby/schemas/identifiers";
import { isMiscProduct } from "@cubby/shared";
import { selectDecisionModel } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { PRODUCT_IDENTITY_FEATURE } from "~/server/ai/policy/feature-identity";
import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  product,
  entityExternalId,
  entitySource,
  entityAttachment,
  image,
} from "~/server/db/schema";
import { loadSelectedDescriptions } from "~/server/domains/image/repo/image-description-selection";
import {
  loadProductIdentifierClaims,
  retainedProductIdentifierClaim,
} from "~/server/domains/product/repo/product-identity-claims";
import {
  readVariantVerification,
  variantVerification,
  variantSourceSide,
} from "~/server/domains/product/repo/product-variant-evidence";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";

/**
 * Product identity evidence: the frozen per-Product snapshot, the prepared
 * pair a decision compares, and the queued pair work. No model calls; the
 * decision itself is `ai/product-identity.ts`.
 */
export async function productIdentitySnapshot(db: Database, id: ProductId) {
  const client = getDb(db);
  const [row] = await client
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      model: product.model,
      aliases: product.aliases,
    })
    .from(product)
    .where(and(eq(product.id, id), notDeleted(product)))
    .limit(1);
  if (!row) return null;
  const identifiers = await client
    .select({
      source: entityExternalId.source,
      kind: entityExternalId.kind,
      value: entityExternalId.externalId,
    })
    .from(entityExternalId)
    .where(
      and(
        eq(entityExternalId.entityKind, "product"),
        eq(entityExternalId.entityId, id),
        notDeleted(entityExternalId),
      ),
    )
    .orderBy(
      entityExternalId.source,
      entityExternalId.kind,
      entityExternalId.externalId,
    );
  const sources = await client
    .select({
      id: entitySource.id,
      field: entitySource.fieldPath,
      valueFingerprint: entitySource.valueFingerprint,
      selectedVariant: entitySource.selectedVariant,
      url: entitySource.url,
      quote: entitySource.quote,
    })
    .from(entitySource)
    .where(
      and(
        eq(entitySource.entityKind, "product"),
        eq(entitySource.entityId, id),
      ),
    )
    .orderBy(entitySource.id);
  const photoRows = await client
    .select({
      id: image.id,
      shortcode: image.shortcode,
      hash: image.sha256,
      purpose: entityAttachment.purpose,
    })
    .from(entityAttachment)
    .innerJoin(image, eq(image.id, entityAttachment.imageId))
    .where(
      and(
        eq(entityAttachment.entityKind, "product"),
        eq(entityAttachment.entityId, id),
        notDeleted(entityAttachment),
        notDeleted(image),
      ),
    )
    .orderBy(image.id);
  const descriptions = await loadSelectedDescriptions(
    db,
    photoRows.map((row) => row.shortcode),
  );
  const photos = photoRows.map(({ shortcode, ...row }) => ({
    ...row,
    description: descriptions.get(shortcode) ?? null,
  }));
  // Verification is a current-value receipt, not title parsing or a source merely mentioning the model.
  const modelFingerprint = await sha256Hex(canonicalJson(row.model));
  const currentModelSources = sources.filter(
    (source) =>
      source.field === "model" && source.valueFingerprint === modelFingerprint,
  );
  const manufacturerFingerprint = await sha256Hex(
    canonicalJson(row.manufacturer),
  );
  const claims = await loadProductIdentifierClaims(db, id);
  const snapshot = {
    ...row,
    identifiers,
    claims,
    sources,
    photos,
    verifiedModel: currentModelSources.length ? row.model : null,
    verifiedManufacturer: sources.some(
      (source) =>
        source.field === "manufacturer" &&
        source.valueFingerprint === manufacturerFingerprint,
    )
      ? row.manufacturer
      : null,
  };
  return {
    snapshot: z.json().parse(snapshot),
    fingerprint: await sha256Hex(canonicalJson(z.json().parse(snapshot))),
    eligible: !isMiscProduct(row.name),
  };
}
const identityFacts = z
  .object({
    identifiers: z.array(
      z.object({ source: z.string(), kind: z.string(), value: z.string() }),
    ),
    verifiedModel: z.string().nullable(),
    verifiedManufacturer: z.string().nullable(),
    claims: z.array(retainedProductIdentifierClaim),
  })
  .passthrough();
export const preparedProductIdentityPair = z.object({
  productIds: z.tuple([productId, productId]),
  first: z.json(),
  second: z.json(),
  fingerprint: z.string(),
  exact: z.boolean(),
  conflict: z.boolean(),
  priorConflictIds: z.array(z.uuid()).default([]),
  verification: variantVerification.default("unknown"),
  variantEvidence: z.json().nullable().default(null),
});
export async function prepareProductIdentityPair(
  db: Database,
  ids: readonly [ProductId, ProductId],
  options: {
    variantEvidence?: z.infer<ReturnType<typeof z.json>>;
    includeExcluded?: boolean;
  } = {},
) {
  const [aId, bId] = ids[0] < ids[1] ? ids : [ids[1], ids[0]];
  if (aId === bId)
    throw new Error("A Product cannot be assessed against itself");
  const [first, second] = await Promise.all([
    productIdentitySnapshot(db, aId!),
    productIdentitySnapshot(db, bId!),
  ]);
  if (
    !first ||
    !second ||
    (!options.includeExcluded && (!first.eligible || !second.eligible))
  )
    return null;
  const a = identityFacts.parse(first.snapshot),
    b = identityFacts.parse(second.snapshot);
  const registeredClaims = (facts: typeof a) =>
    facts.identifiers.map((identifier) => ({
      ...identifier,
      exactVariant: ["asin", "gtin_14", "manufacturer_part"].includes(
        identifier.kind,
      ),
      variant: null,
      productUrl: null,
    }));
  const aClaims = [...registeredClaims(a), ...a.claims],
    bClaims = [...registeredClaims(b), ...b.claims];
  const exact = aClaims.some((one) =>
    bClaims.some(
      (other) =>
        one.source === other.source &&
        one.kind === other.kind &&
        one.value === other.value &&
        one.exactVariant &&
        other.exactVariant,
    ),
  );
  const guard = await readVariantVerification(
    db,
    [
      variantSourceSide.parse(first.snapshot),
      variantSourceSide.parse(second.snapshot),
    ],
    PRODUCT_IDENTITY_FEATURE.promptVersion,
    options.variantEvidence,
  );
  return preparedProductIdentityPair.parse({
    productIds: [aId, bId],
    first: first.snapshot,
    second: second.snapshot,
    fingerprint: await sha256Hex(
      canonicalJson([first.fingerprint, second.fingerprint].sort()),
    ),
    exact,
    ...guard,
    conflict:
      (a.verifiedModel !== null &&
        b.verifiedModel !== null &&
        a.verifiedModel !== b.verifiedModel) ||
      guard.conflict,
  });
}
/** Canonical work identity shares actual producer lineage and frozen pair input. */
export async function enqueueProductIdentityPair(
  db: Database,
  ids: readonly [ProductId, ProductId],
  runId: RunId,
  provenance: AiProvenance,
) {
  const pair = await prepareProductIdentityPair(db, ids);
  if (!pair) throw new Error("Product identity target no longer exists");
  const shareKey = `product-identity:${await sha256Hex(canonicalJson({ productIds: pair.productIds, fingerprint: pair.fingerprint, dependencies: provenance.dependencies, optionFingerprint: provenance.optionFingerprint }))}`;
  const frozen = aiProvenance.parse({
    ...provenance,
    inputFingerprint: pair.fingerprint,
    model: provenance.model ?? selectDecisionModel(),
  });
  return enqueueAiEvaluation(db, {
    runId: runEntityId.parse(runId),
    executionKind: "ai_refresh",
    feature: PRODUCT_IDENTITY_FEATURE.feature,
    workKey: shareKey,
    shareKey,
    target: {
      kind: "product_pair",
      entity: "product",
      recordId: pair.productIds[0],
      otherId: pair.productIds[1],
      field: null,
      assessmentIds: [],
    },
    provenance: frozen,
    snapshot: z.json().parse(pair),
  });
}
