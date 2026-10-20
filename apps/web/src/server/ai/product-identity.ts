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
import {
  PRODUCT_IDENTITY_FEATURE,
  PRODUCT_IDENTITY_RULE_REVISION,
} from "~/server/ai/policy/feature-identity";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { product, entityExternalId } from "~/server/db/schema";
import {
  prepareProductIdentityPair,
  preparedProductIdentityPair,
  productIdentitySnapshot,
} from "~/server/domains/product/repo/match/product-identity-snapshot";
import {
  loadProductIdentifierClaims,
  type DroppedProductIdentifierClaim,
} from "~/server/domains/product/repo/product-identity-claims";
import { findSimilarEntities } from "~/server/generic/embedding/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/generic/embedding/service/semantic/embeddings";
import { productionVectorStore } from "~/server/generic/embedding/service/semantic/vector-store";

export const productIdentityPrompt = (subject: string) => ({
  subject,
  rules:
    "Compare two records of physical products. Exact identifiers are evidence. Matching model text and research notes never verify identity. Shared family, similar names or photos do not establish the same variant. Keep unknown sizes and colors unknown. Differing current models and historical identity conflicts block merging. Judge only this pair; never infer identity through another pair.",
  choices: [
    "Same exact variant with supporting evidence",
    "Distinct variants",
    "Identity conflict in exact identifiers",
    "Insufficient evidence",
  ],
  allowNone: false,
});
/** What catalog retrieval could not see, recorded on the evaluation result
 * rather than silently narrowing the candidate set. */
export type ProductIdentityRetrievalCoverage = {
  droppedClaims: DroppedProductIdentifierClaim[];
  semanticNeighbours:
    | { status: "queried"; count: number }
    | { status: "unconfigured" }
    | { status: "failed"; error: string };
};
export async function retrieveProductIdentityCandidates(
  db: Database,
  id: ProductId,
): Promise<{
  candidates: ProductId[];
  coverage: ProductIdentityRetrievalCoverage;
}> {
  const coverage: ProductIdentityRetrievalCoverage = {
    droppedClaims: [],
    semanticNeighbours: { status: "unconfigured" },
  };
  const client = getDb(db);
  const [seed] = await client
    .select()
    .from(product)
    .where(and(eq(product.id, id), notDeleted(product)))
    .limit(1);
  if (!seed || isMiscProduct(seed.name)) return { candidates: [], coverage };
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
  const claims = await loadProductIdentifierClaims(db, undefined, {
    onDropped: (dropped) => coverage.droppedClaims.push(dropped),
  });
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
    try {
      const scan = await findSimilarEntities(
        db,
        productionVectorStore,
        { entityKind: "product", entityId: id },
        {
          targetType: "product",
          limit: 20,
          config: getSemanticEmbeddingConfig(),
        },
      );
      coverage.semanticNeighbours = scan.complete
        ? { status: "queried", count: scan.candidates.length }
        : {
            status: "failed",
            error: "Semantic candidate coverage is pending or incomplete",
          };
      for (const neighbour of scan.candidates)
        ids.add(parseEntityId("product", neighbour.entityId));
    } catch (error) {
      // Exact and lexical retrieval still stand; the outage is on the result.
      coverage.semanticNeighbours = {
        status: "failed",
        error: getErrorMessage(error),
      };
    }
  return {
    candidates: [...ids].filter((other) => other !== id).sort(),
    coverage,
  };
}
export async function prepareProductIdentityCatalog(
  db: Database,
  id: ProductId,
) {
  const source = await productIdentitySnapshot(db, id);
  if (!source?.eligible) return { eligible: false, pairs: [], coverage: null };
  const pairs = [];
  const { candidates, coverage } = await retrieveProductIdentityCandidates(
    db,
    id,
  );
  for (const other of candidates) {
    const pair = await prepareProductIdentityPair(db, [id, other]);
    if (pair) pairs.push(pair);
  }
  return { eligible: true, pairs, coverage };
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
  const current = await prepareProductIdentityPair(db, pair.productIds);
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
        ? "A historical identity conflict remains unresolved"
        : pair.exact
          ? current.conflict
            ? "An exact identifier conflicts with current model values"
            : "Retained identifier evidence binds both records to the same exact identifier"
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
