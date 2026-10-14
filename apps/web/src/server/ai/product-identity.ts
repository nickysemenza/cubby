import { aiProvenance, type AiProvenance } from "@cubby/schemas/ai-evaluation";
import { entitySchema } from "@cubby/schemas/entity-core";
import { productId, runEntityId, type RunId } from "@cubby/schemas/identifiers";
import { parseEntityId, type ProductId } from "@cubby/schemas/identifiers";
import { isMiscProduct } from "@cubby/shared";
import { getErrorMessage } from "@cubby/shared";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { selectDecisionModel } from "@cubby/shared/ai/models";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  runDecisionChoice,
  type DecisionPort,
} from "~/server/ai/decision-model";
import {
  PRODUCT_IDENTITY_FEATURE,
  PRODUCT_IDENTITY_RULE_REVISION,
} from "~/server/ai/features";
import type { Database } from "~/server/db";
import {
  product,
  entityExternalId,
  entitySource,
  entityAttachment,
  image,
} from "~/server/db/schema";
import { enqueueAiEvaluation } from "~/server/repo/ai-evaluation-requests";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { findSimilarEntities } from "~/server/repo/entity-embedding";
import { canonicalJson } from "~/server/repo/entity-source";
import { loadSelectedDescriptions } from "~/server/repo/image-description-selection";
import {
  loadProductIdentifierClaims,
  retainedProductIdentifierClaim,
} from "~/server/repo/product-identity-claims";
import { publishProductPair } from "~/server/repo/product-match-candidate";
import {
  sourceConfirmedVariantFacts,
  verifiedVariantFacts,
} from "~/server/repo/product-variant-comparison";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";
import { productionVectorStore } from "~/server/semantic/vector-store";

export const productIdentityPrompt = (subject: string) => ({
  subject,
  rules:
    "Compare two records of physical products. Exact identifiers and source-confirmed variant facts are evidence. Shared family, similar names or photos do not establish the same variant. Keep unknown sizes and colors unknown. Distinct verified variants outrank similarity. Judge only this pair; never infer identity through another pair.",
  choices: [
    "Same exact variant with supporting evidence",
    "Distinct verified variants",
    "Identity conflict in exact identifiers",
    "Insufficient evidence",
  ],
  allowNone: false,
});
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
  const nameFingerprint = await sha256Hex(canonicalJson(row.name));
  const manufacturerFingerprint = await sha256Hex(
    canonicalJson(row.manufacturer),
  );
  const verifiedVariant = sourceConfirmedVariantFacts(
    row.name,
    sources
      .filter(
        (source) =>
          source.field === "name" &&
          source.valueFingerprint === nameFingerprint,
      )
      .map((source) =>
        [source.quote, source.selectedVariant].filter(Boolean).join(" · "),
      ),
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
    verifiedVariant,
  };
  return {
    snapshot: z.json().parse(snapshot),
    fingerprint: await sha256Hex(canonicalJson(z.json().parse(snapshot))),
    eligible: !isMiscProduct(row.name),
  };
}
export async function retrieveProductIdentityCandidates(
  db: Database,
  id: ProductId,
) {
  const client = getDb(db);
  const [seed] = await client
    .select()
    .from(product)
    .where(and(eq(product.id, id), notDeleted(product)))
    .limit(1);
  if (!seed || isMiscProduct(seed.name)) return [];
  const exact = sql`EXISTS (SELECT 1 FROM "EntityExternalId" own JOIN "EntityExternalId" other ON other.source=own.source AND other.kind=own.kind AND other."externalId"=own."externalId" WHERE own."entityKind"=${entitySchema.enum.product} AND own."entityId"=${id} AND own."deletedAt" IS NULL AND other."entityKind"=${entitySchema.enum.product} AND other."entityId"="Product".id AND other."deletedAt" IS NULL)`;
  const candidates = await client
    .select({ id: product.id })
    .from(product)
    .where(
      and(
        notDeleted(product),
        ne(product.id, id),
        or(
          exact,
          sql`EXISTS (SELECT 1 FROM "EntitySource" own JOIN "EntitySource" other ON other.url=own.url WHERE own."entityKind"=${entitySchema.enum.product} AND own."entityId"=${id} AND own.url <> '' AND other."entityKind"=${entitySchema.enum.product} AND other."entityId"="Product".id)`,
          and(
            eq(product.manufacturer, seed.manufacturer),
            eq(product.model, seed.model ?? ""),
          ),
          sql`EXISTS (SELECT 1 FROM unnest(ARRAY[${product.name}] || ${product.aliases}) candidate(name) WHERE lower(candidate.name) IN (SELECT lower(value) FROM jsonb_array_elements_text(${JSON.stringify([seed.name, ...seed.aliases])}::jsonb)))`,
        ),
      ),
    )
    .orderBy(product.id);
  const ids = new Set(candidates.map((row) => row.id));
  const claims = await loadProductIdentifierClaims(db);
  const ownClaims = claims.filter((claim) => claim.productId === id);
  const ownSnapshot = await productIdentitySnapshot(db, id);
  const ownRegistered = z
    .object({
      identifiers: z.array(
        z.object({ source: z.string(), kind: z.string(), value: z.string() }),
      ),
    })
    .parse(ownSnapshot?.snapshot);
  const known = [...ownClaims, ...ownRegistered.identifiers];
  for (const claim of claims)
    if (
      known.some(
        (own) =>
          own.source === claim.source &&
          own.kind === claim.kind &&
          own.value === claim.value,
      )
    )
      ids.add(parseEntityId("product", claim.productId));
  for (const claim of ownClaims) {
    const owners = await client
      .select({ id: entityExternalId.entityId })
      .from(entityExternalId)
      .where(
        and(
          eq(entityExternalId.entityKind, "product"),
          eq(entityExternalId.source, claim.source),
          eq(
            entityExternalId.kind,
            z.enum(["asin", "retailer_sku"]).parse(claim.kind),
          ),
          eq(entityExternalId.externalId, claim.value),
          notDeleted(entityExternalId),
        ),
      );
    for (const owner of owners) ids.add(parseEntityId("product", owner.id));
  }
  if (semanticEmbeddingsConfigured())
    for (const neighbour of await findSimilarEntities(
      productionVectorStore,
      { entityKind: "product", entityId: id },
      { targetType: "product", limit: 20 },
    ))
      ids.add(parseEntityId("product", neighbour.entityId));
  return [...ids].filter((other) => other !== id).sort();
}
const identityFacts = z
  .object({
    identifiers: z.array(
      z.object({ source: z.string(), kind: z.string(), value: z.string() }),
    ),
    verifiedModel: z.string().nullable(),
    verifiedManufacturer: z.string().nullable(),
    verifiedVariant: verifiedVariantFacts,
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
});
export async function prepareProductIdentityPair(
  db: Database,
  ids: readonly [ProductId, ProductId],
) {
  const [aId, bId] = ids[0] < ids[1] ? ids : [ids[1], ids[0]];
  if (aId === bId)
    throw new Error("A Product cannot be assessed against itself");
  const [first, second] = await Promise.all([
    productIdentitySnapshot(db, aId!),
    productIdentitySnapshot(db, bId!),
  ]);
  if (!first?.eligible || !second?.eligible) return null;
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
  const variantDimensions = verifiedVariantFacts.keyof().options;
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
    fingerprint: await sha256Hex(
      canonicalJson([first.fingerprint, second.fingerprint].sort()),
    ),
    exact,
    conflict:
      (a.verifiedModel !== null &&
        b.verifiedModel !== null &&
        a.verifiedModel !== b.verifiedModel) ||
      variantDimensions.some(
        (key) =>
          a.verifiedVariant[key] !== null &&
          b.verifiedVariant[key] !== null &&
          a.verifiedVariant[key] !== b.verifiedVariant[key],
      ),
  });
}
export async function prepareProductIdentityCatalog(
  db: Database,
  id: ProductId,
) {
  const source = await productIdentitySnapshot(db, id);
  if (!source?.eligible) return { eligible: false, pairs: [] };
  const pairs = [];
  for (const other of await retrieveProductIdentityCandidates(db, id)) {
    const pair = await prepareProductIdentityPair(db, [id, other]);
    if (pair) pairs.push(pair);
  }
  return { eligible: true, pairs };
}
export async function evaluatePreparedProductIdentityPair(
  db: Database,
  raw: z.infer<typeof preparedProductIdentityPair>,
  runId: RunId,
  options: {
    decisionPort?: DecisionPort;
    model?: string | null;
    evaluationId?: string;
    provenance?: AiProvenance;
  } = {},
) {
  const pair = preparedProductIdentityPair.parse(raw);
  const model = supportedDecisionModelSchema.parse(
    options.model ?? selectDecisionModel(),
  );
  const decision = pair.exact
    ? null
    : await runDecisionChoice({
        ...productIdentityPrompt(JSON.stringify([pair.first, pair.second])),
        feature: PRODUCT_IDENTITY_FEATURE,
        decisionModel: model,
        port: options.decisionPort,
        usage: { db, runId, operation: "product-identity" },
      });
  return {
    productIds: pair.productIds,
    source: "detector" as const,
    evidence: pair.exact
      ? pair.conflict
        ? "An exact identifier conflicts with source-confirmed variants"
        : "Retained source evidence binds both records to the same exact identifier"
      : "Candidate similarity requires member investigation",
    sourceUrls: [],
    fingerprint: pair.fingerprint,
    signals: z.json().parse({
      exact: pair.exact,
      decision,
      servedModel: pair.exact ? null : model,
      policy: options.provenance
        ? {
            dependencies: options.provenance.dependencies,
            optionFingerprint: options.provenance.optionFingerprint,
          }
        : null,
      snapshots: [pair.first, pair.second],
    }),
    actionable: pair.exact,
    conflict: pair.conflict,
    producer: pair.exact
      ? {
          kind: "rule" as const,
          model: null,
          revision: PRODUCT_IDENTITY_RULE_REVISION,
          runId,
          evaluationId: options.evaluationId ?? null,
        }
      : {
          kind: "model" as const,
          model,
          revision: PRODUCT_IDENTITY_FEATURE.promptVersion,
          runId,
          evaluationId: options.evaluationId ?? null,
        },
  };
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
export async function evaluateProductIdentity(
  db: Database,
  id: ProductId,
  runId: RunId,
  ports: { decisionPort?: DecisionPort } = {},
) {
  const prepared = await prepareProductIdentityCatalog(db, id);
  const pairs = [];
  let failure: string | null = null;
  for (const pair of prepared.pairs) {
    try {
      pairs.push(
        await evaluatePreparedProductIdentityPair(db, pair, runId, ports),
      );
    } catch (error) {
      failure = getErrorMessage(error);
    }
  }
  return { eligible: prepared.eligible, pairs, failure };
}
export async function publishProductIdentity(
  db: Database,
  result: Pick<Awaited<ReturnType<typeof evaluateProductIdentity>>, "pairs">,
) {
  for (const pair of result.pairs) await publishProductPair(db, pair);
}
