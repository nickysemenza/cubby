import { aiProvenance, type AiProvenance } from "@cubby/schemas/ai-evaluation";
import { productId, runEntityId, type RunId } from "@cubby/schemas/identifiers";
import type { ProductId } from "@cubby/schemas/identifiers";
import { isMiscProduct } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";
import { groupBy } from "es-toolkit";
import { z } from "zod";

import { PRODUCT_IDENTITY_FEATURE } from "~/server/ai/policy/feature-identity";
import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
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
  readVariantVerifications,
  variantVerification,
  productIdentitySide,
  type ProductVariantVerification,
} from "~/server/domains/product/repo/product-variant-evidence";
import { canonicalJson } from "~/server/lib/canonical-json";

import {
  productIdentityEvidenceFence,
  productIdentityEvidenceFences,
} from "./product-identity-fence";

/**
 * Product identity evidence: the frozen per-Product snapshot, the prepared
 * pair a decision compares, and the queued pair work. No model calls; the
 * decision itself is `ai/product-identity.ts`.
 */
export async function productIdentitySnapshot(db: Database, id: ProductId) {
  return (await productIdentitySnapshots(db, [id])).get(id) ?? null;
}

export type ProductIdentitySnapshot = {
  snapshot: z.infer<ReturnType<typeof z.json>>;
  fingerprint: string;
  eligible: boolean;
};
/** Set-based snapshot reads for list checks; deleted Products are absent. */
export async function productIdentitySnapshots(
  db: Database,
  ids: readonly ProductId[],
) {
  const client = getDb(db);
  const unique = [...new Set(ids)];
  const result = new Map<ProductId, ProductIdentitySnapshot>();
  if (!unique.length) return result;
  // Sequential: a transaction handle runs one statement at a time.
  const rows = await client
    .select({
      id: product.id,
      name: product.name,
      brandId: product.brandId,
      brandName: productBrandNameSql(product.brandId),
      model: product.model,
      aliases: product.aliases,
    })
    .from(product)
    .where(and(inArray(product.id, unique), notDeleted(product)));
  if (!rows.length) return result;
  const live = rows.map((row) => row.id);
  const identifierRows = await client
    .select({
      entityId: entityExternalId.entityId,
      source: entityExternalId.source,
      kind: entityExternalId.kind,
      value: entityExternalId.externalId,
    })
    .from(entityExternalId)
    .where(
      and(
        eq(entityExternalId.entityKind, "product"),
        inArray(entityExternalId.entityId, live),
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
      entityId: entityAttachment.entityId,
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
        inArray(entityAttachment.entityId, live),
        notDeleted(entityAttachment),
        notDeleted(image),
      ),
    )
    .orderBy(image.id);
  const descriptions = await loadSelectedDescriptions(db, [
    ...new Set(photoRows.map((row) => row.shortcode)),
  ]);
  const claims = await loadProductIdentifierClaims(db, live);
  const identifiersByProduct = groupBy(identifierRows, (row) => row.entityId);
  const photosByProduct = groupBy(photoRows, (row) => row.entityId);
  const claimsByProduct = groupBy(claims, (row) => row.productId);
  for (const row of rows) {
    const identifiers = (identifiersByProduct[row.id] ?? []).map(
      ({ source, kind, value }) => ({ source, kind, value }),
    );
    const photos = (photosByProduct[row.id] ?? []).map(
      ({ id, hash, purpose, shortcode }) => ({
        id,
        hash,
        purpose,
        description: descriptions.get(shortcode) ?? null,
      }),
    );
    const claims = claimsByProduct[row.id] ?? [];
    const snapshot = z.json().parse({ ...row, identifiers, claims, photos });
    result.set(row.id, {
      snapshot,
      fingerprint: await sha256Hex(canonicalJson(snapshot)),
      eligible: !isMiscProduct(row.name),
    });
  }
  return result;
}
/** Order-independent pair fingerprint over two snapshot fingerprints. */
export const pairFingerprint = (fingerprints: readonly [string, string]) =>
  sha256Hex(canonicalJson([...fingerprints].sort()));
/** Current pair fingerprint, independent of argument order; null once either Product is gone. */
export async function productPairFingerprint(
  db: Database,
  ids: readonly [ProductId, ProductId],
) {
  const snapshots = await productIdentitySnapshots(db, ids);
  const [first, second] = ids.map((id) => snapshots.get(id)?.fingerprint);
  return first && second ? pairFingerprint([first, second]) : null;
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
export type ProductIdentityPairIds = readonly [ProductId, ProductId];
export const productIdentityPairKey = (ids: ProductIdentityPairIds): string =>
  [...ids].sort().join("|");

/** No database reads: all pair evidence comes from the page's frozen context. */
async function productIdentityPairFromSnapshots(
  ids: ProductIdentityPairIds,
  snapshots: ReadonlyMap<ProductId, ProductIdentitySnapshot>,
  verification: ProductVariantVerification,
  options: { includeExcluded?: boolean } = {},
) {
  const [aId, bId] = ids[0] < ids[1] ? ids : ([ids[1], ids[0]] as const);
  if (aId === bId)
    throw new Error("A Product cannot be assessed against itself");
  const first = snapshots.get(aId),
    second = snapshots.get(bId);
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
  return preparedProductIdentityPair.parse({
    productIds: [aId, bId],
    first: first.snapshot,
    second: second.snapshot,
    fingerprint: await pairFingerprint([first.fingerprint, second.fingerprint]),
    exact,
    ...verification,
  });
}

/** One bounded history load for every canonical pair in the snapshot union. */
export async function productIdentityPairsFromSnapshots(
  db: Database,
  ids: readonly ProductIdentityPairIds[],
  snapshots: ReadonlyMap<ProductId, ProductIdentitySnapshot>,
  options: { includeExcluded?: boolean } = {},
) {
  const unique = new Map(
    ids.map((pair) => [productIdentityPairKey(pair), pair]),
  );
  const sides = [...unique.values()].flatMap((pair) => {
    const [aId, bId] = pair[0] < pair[1] ? pair : ([pair[1], pair[0]] as const);
    const first = snapshots.get(aId),
      second = snapshots.get(bId);
    return first && second
      ? [
          [
            productIdentitySide.parse(first.snapshot),
            productIdentitySide.parse(second.snapshot),
          ] as const,
        ]
      : [];
  });
  const history = await readVariantVerifications(db, sides);
  const result = new Map<string, z.infer<typeof preparedProductIdentityPair>>();
  for (const [key, pair] of unique) {
    const verification = history.get(key);
    if (!verification) continue;
    const prepared = await productIdentityPairFromSnapshots(
      pair,
      snapshots,
      verification,
      options,
    );
    if (prepared) result.set(key, prepared);
  }
  return result;
}
export async function prepareProductIdentityPairs(
  db: Database,
  ids: readonly ProductIdentityPairIds[],
  options: { includeExcluded?: boolean } = {},
) {
  const snapshots = await productIdentitySnapshots(
    db,
    ids.flatMap((pair) => [...pair]),
  );
  return productIdentityPairsFromSnapshots(db, ids, snapshots, options);
}
export async function prepareProductIdentityPair(
  db: Database,
  ids: ProductIdentityPairIds,
  options: { includeExcluded?: boolean } = {},
) {
  return (
    (await prepareProductIdentityPairs(db, [ids], options)).get(
      productIdentityPairKey(ids),
    ) ?? null
  );
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
    model: provenance.model,
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
export async function prepareProductIdentityPairRequests(
  db: Database,
  expected: readonly z.infer<typeof preparedProductIdentityPair>[],
  runId: RunId,
  provenance: AiProvenance,
) {
  const prepared = await prepareFencedProductIdentityPairs(db, expected);
  if (
    prepared.some(
      ({ pair }, index) => pair.fingerprint !== expected[index]!.fingerprint,
    )
  )
    throw new Error("Product pair evidence changed during inference");
  return prepared.map(
    ({ pair, fence }) =>
      (db: Database) =>
        withTransactionDatabase(
          db,
          async (tx) => {
            if (
              (await productIdentityEvidenceFence(tx, pair.productIds)) !==
              fence
            )
              throw new Error("Product pair evidence changed during inference");
            return enqueuePreparedProductIdentityPair(
              tx,
              pair,
              runId,
              provenance,
            );
          },
          { isolationLevel: "serializable" },
        ),
  );
}

/** Batch unlocked evidence preparation; each publication still checks its own fence. */
export async function prepareFencedProductIdentityPairs(
  db: Database,
  expected: readonly {
    productIds: readonly [ProductId, ProductId];
    fingerprint?: string | null;
  }[],
) {
  if (isTransaction(getDb(db)))
    throw new Error(
      "Product pair preparation requires a database outside a transaction",
    );
  const ids = expected.map((pair) => pair.productIds);
  const targets = ids.map((productIds) => ({ key: productIdentityPairKey(productIds), productIds }));
  const before = await productIdentityEvidenceFences(db, targets);
  const pairs = await prepareProductIdentityPairs(db, ids);
  const after = await productIdentityEvidenceFences(db, targets);
  return expected.map((input) => {
    const key = productIdentityPairKey(input.productIds);
    const pair = pairs.get(key);
    if (
      !pair ||
      (input.fingerprint && pair.fingerprint !== input.fingerprint) ||
      before.get(key) !== after.get(key)
    )
      throw new Error("Product pair evidence changed during inference");
    return { pair, fence: before.get(key)! };
  });
}
