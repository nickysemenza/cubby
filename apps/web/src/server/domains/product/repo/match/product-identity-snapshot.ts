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
import {
  getDb,
  isTransaction,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  product,
  entityExternalId,
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
  productIdentitySide,
} from "~/server/domains/product/repo/product-variant-evidence";
import { canonicalJson } from "~/server/lib/canonical-json";

import { productIdentityEvidenceFence } from "./product-identity-fence";

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
  const claims = await loadProductIdentifierClaims(db, id);
  const snapshot = { ...row, identifiers, claims, photos };
  return {
    snapshot: z.json().parse(snapshot),
    fingerprint: await sha256Hex(canonicalJson(z.json().parse(snapshot))),
    eligible: !isMiscProduct(row.name),
  };
}
/** Current pair fingerprint, independent of argument order; null once either Product is gone. */
export async function productPairFingerprint(
  db: Database,
  ids: readonly [ProductId, ProductId],
) {
  const snapshots = await Promise.all(
    ids.map((id) => productIdentitySnapshot(db, id)),
  );
  if (snapshots.some((value) => !value)) return null;
  return sha256Hex(
    canonicalJson(snapshots.map((value) => value!.fingerprint).sort()),
  );
}
const identityFacts = z
  .object({
    identifiers: z.array(
      z.object({ source: z.string(), kind: z.string(), value: z.string() }),
    ),
    model: z.string().nullable(),
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
  const guard = await readVariantVerification(db, [
    productIdentitySide.parse(first.snapshot),
    productIdentitySide.parse(second.snapshot),
  ]);
  return preparedProductIdentityPair.parse({
    productIds: [aId, bId],
    first: first.snapshot,
    second: second.snapshot,
    fingerprint: await sha256Hex(
      canonicalJson([first.fingerprint, second.fingerprint].sort()),
    ),
    exact,
    ...guard,
  });
}
/** Canonical work identity shares actual producer lineage and frozen pair input. */
async function enqueuePreparedProductIdentityPair(
  db: Database,
  pair: z.infer<typeof preparedProductIdentityPair>,
  runId: RunId,
  provenance: AiProvenance,
) {
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

/** A queued pair carries the same frozen evidence checked in its short write transaction.
 * Publication accepts a root handle or a caller-owned SERIALIZABLE transaction;
 * savepoints inherit outer isolation and cannot upgrade it.
 */
export async function prepareProductIdentityPairRequest(
  db: Database,
  expected: z.infer<typeof preparedProductIdentityPair>,
  runId: RunId,
  provenance: AiProvenance,
) {
  if (isTransaction(getDb(db)))
    throw new Error(
      "Product pair preparation requires a database outside a transaction",
    );
  const fence = await productIdentityEvidenceFence(db, expected.productIds);
  const pair = await prepareProductIdentityPair(db, expected.productIds);
  if (
    !pair ||
    pair.fingerprint !== expected.fingerprint ||
    (await productIdentityEvidenceFence(db, expected.productIds)) !== fence
  )
    throw new Error("Product pair evidence changed during inference");
  return (db: Database) =>
    withTransactionDatabase(
      db,
      async (tx) => {
        if ((await productIdentityEvidenceFence(tx, pair.productIds)) !== fence)
          throw new Error("Product pair evidence changed during inference");
        return enqueuePreparedProductIdentityPair(tx, pair, runId, provenance);
      },
      { isolationLevel: "serializable" },
    );
}
