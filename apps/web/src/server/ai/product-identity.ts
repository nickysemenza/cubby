import type { AiProvenance } from "@cubby/schemas/ai-evaluation";
import { entitySchema } from "@cubby/schemas/entity-core";
import type { RunId } from "@cubby/schemas/identifiers";
import { parseEntityId, type ProductId } from "@cubby/schemas/identifiers";
import { isMiscProduct } from "@cubby/shared";
import { getErrorMessage } from "@cubby/shared";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { selectDecisionModel } from "@cubby/shared/ai/models";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  runDecisionChoice,
  type DecisionPort,
} from "~/server/ai/decision-model";
import { groundProductIdentityVariants } from "~/server/ai/product-identity-grounding";
import {
  PRODUCT_IDENTITY_FEATURE,
  PRODUCT_IDENTITY_RULE_REVISION,
} from "~/server/ai/repo/feature-identity";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { product, entityExternalId } from "~/server/db/schema";
import {
  prepareProductIdentityPair,
  preparedProductIdentityPair,
  productIdentitySnapshot,
} from "~/server/domains/product/repo/match/product-identity-snapshot";
import { publishProductPair } from "~/server/domains/product/repo/match/product-match-candidate";
import { loadProductIdentifierClaims } from "~/server/domains/product/repo/product-identity-claims";
import { variantSourceSide } from "~/server/domains/product/repo/product-variant-evidence";
import { findSimilarEntities } from "~/server/generic/embedding/repo/entity-embedding";
import { semanticEmbeddingsConfigured } from "~/server/generic/embedding/service/semantic/embeddings";
import { productionVectorStore } from "~/server/generic/embedding/service/semantic/vector-store";

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
          sql`EXISTS (SELECT 1 FROM "EntitySource" own JOIN "EntitySource" other ON lower(btrim(other."selectedVariant"))=lower(btrim(own."selectedVariant")) WHERE own."entityKind"=${entitySchema.enum.product} AND own."entityId"=${id} AND btrim(own."selectedVariant") <> '' AND other."entityKind"=${entitySchema.enum.product} AND other."entityId"="Product".id)`,
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
  let proposedGrounding = pair.variantEvidence;
  if (pair.verification !== "current") {
    try {
      proposedGrounding = await groundProductIdentityVariants({
        db,
        runId,
        evaluationId: options.evaluationId,
        model,
        first: variantSourceSide.parse(pair.first),
        second: variantSourceSide.parse(pair.second),
        priorConflictIds: pair.priorConflictIds,
        decisionPort: options.decisionPort,
        provenance: options.provenance,
      });
    } catch {
      // SILENT: Exact identifier admission survives model outage; the historical conflict guard remains enforced.
    }
  }
  const current = await prepareProductIdentityPair(db, pair.productIds, {
    variantEvidence: proposedGrounding,
  });
  if (!current || current.fingerprint !== pair.fingerprint)
    throw new Error("Product identity evidence changed during evaluation");
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
    evidence:
      current.verification === "pending_verification"
        ? "A historical source-grounded conflict requires fresh current verification before merging"
        : pair.exact
          ? current.conflict
            ? "An exact identifier conflicts with source-grounded variant judgments"
            : "Retained source evidence binds both records to the same exact identifier"
          : "Candidate similarity requires member investigation",
    sourceUrls: [],
    fingerprint: pair.fingerprint,
    signals: z.json().parse({
      exact: pair.exact,
      verification: current.verification,
      variantEvidence: current.variantEvidence,
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
    conflict: current.conflict,
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
export async function evaluateProductIdentity(
  db: Database,
  id: ProductId,
  runId: RunId,
  ports: NonNullable<
    Parameters<typeof evaluatePreparedProductIdentityPair>[3]
  > = {},
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
