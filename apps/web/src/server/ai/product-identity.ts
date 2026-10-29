import type { AiProvenance } from "@cubby/schemas/ai-evaluation";
import { entitySchema } from "@cubby/schemas/entity-core";
import type { RunId } from "@cubby/schemas/identifiers";
import { parseEntityId, type ProductId } from "@cubby/schemas/identifiers";
import { isMiscProduct } from "@cubby/shared";
import { getErrorMessage } from "@cubby/shared";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { and, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { chunk } from "es-toolkit";
import { z } from "zod";

import { normalizeSearchText } from "~/lib/search-normalization";
import {
  decisionModelFor,
  runDecisionChoice,
  settleDecisionWorkItems,
  type DecisionPort,
} from "~/server/ai/decision-model";
import {
  PRODUCT_IDENTITY_FEATURE,
  PRODUCT_IDENTITY_RULE_REVISION,
} from "~/server/ai/policy/feature-identity";
import type { Database } from "~/server/db";
import { getDb, notDeleted, isTransaction } from "~/server/db/helpers";
import {
  product,
  entityExternalId,
  entityEmbedding,
  entityIdentity,
  searchDocument,
} from "~/server/db/schema";
import {
  productIdentityEvidenceFences,
  type ProductIdentityFenceTarget,
} from "~/server/domains/product/repo/match/product-identity-fence";
import {
  prepareProductIdentityPair,
  prepareProductIdentityPairs,
  preparedProductIdentityPair,
  productIdentitySnapshots,
  productIdentityPairsFromSnapshots,
  productIdentityPairKey,
  type ProductIdentityPairIds,
} from "~/server/domains/product/repo/match/product-identity-snapshot";
import {
  publishProductPairPublications,
  type PreparedProductPairPublication,
  type ProductPairPublicationResult,
} from "~/server/domains/product/repo/match/product-match-candidate";
import {
  loadProductIdentifierClaims,
  type DroppedProductIdentifierClaim,
} from "~/server/domains/product/repo/product-identity-claims";
import { vectorPayloadHash } from "~/server/generic/embedding/repo/embedding-artifact";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/generic/embedding/service/semantic/embeddings";
import { productionVectorStore } from "~/server/generic/embedding/service/semantic/vector-store";
import {
  prepareSearchDocuments,
  searchCoverageIncomplete,
} from "~/server/generic/search/repo/search-document";
import { nameAliasKeysSql } from "~/server/lib/name-alias-match";

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
type ProductIdentityRetrievalCoverage = {
  droppedClaims: DroppedProductIdentifierClaim[];
  semanticNeighbours:
    | { status: "queried"; count: number }
    | { status: "unconfigured" }
    | { status: "failed"; error: string };
};
const identifierKey = (claim: {
  source: string;
  kind: string;
  value: string;
}) => JSON.stringify([claim.source, claim.kind, claim.value]);

const candidateProduct = alias(product, "c"),
  namedProduct = alias(product, "p");
const ownIdentifier = alias(entityExternalId, "own"),
  otherIdentifier = alias(entityExternalId, "other");

/** One catalog claim load and one source-to-candidate relation per page. */
async function retrieveProductIdentityCandidatePage(
  db: Database,
  sourceIds: readonly ProductId[],
) {
  const client = getDb(db);
  const seeds = new Map<ProductId, { id: ProductId; name: string }>();
  const droppedClaims: DroppedProductIdentifierClaim[] = [];
  const claims = await loadProductIdentifierClaims(db, undefined, {
    onDropped: (dropped) => droppedClaims.push(dropped),
  });
  const results = new Map<
    ProductId,
    {
      eligible: boolean;
      candidates: ProductId[];
      coverage: ProductIdentityRetrievalCoverage;
    }
  >();
  const idsBySource = new Map<ProductId, Set<ProductId>>();
  if (sourceIds.length) {
    const edges = z
      .object({
        rows: z.array(
          z.object({
            sourceId: z.string(),
            sourceName: z.string(),
            candidateId: z.string().nullable(),
          }),
        ),
      })
      .parse(
        await client.execute(sql`
      WITH sources AS MATERIALIZED (SELECT * FROM "Product" WHERE id IN (${sql.join(
        [...new Set(sourceIds)].map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) AND ${notDeleted(product)}),
      names AS MATERIALIZED (SELECT p.id, n.name AS name FROM "Product" p CROSS JOIN LATERAL (${nameAliasKeysSql(sql`p.name`, sql`p.aliases`)}) n WHERE ${notDeleted(namedProduct)}),
      source_names AS (SELECT s.id, n.name AS name FROM sources s CROSS JOIN LATERAL (${nameAliasKeysSql(sql`s.name`, sql`s.aliases`)}) n),
      edges AS (
        SELECT s.id AS source, c.id AS candidate FROM source_names s JOIN names c ON c.name = s.name
        UNION SELECT s.id, c.id FROM sources s JOIN "Product" c ON c."brandId" = s."brandId" AND c.model = coalesce(s.model, '') WHERE s."brandId" IS NOT NULL AND ${notDeleted(candidateProduct)}
        UNION SELECT s.id, c.id FROM sources s JOIN "EntityExternalId" own ON own."entityId" = s.id AND own."entityKind" = ${entitySchema.enum.product} AND ${notDeleted(ownIdentifier)}
          JOIN "EntityExternalId" other ON other.source = own.source AND other.kind = own.kind AND other."externalId" = own."externalId" AND other."entityKind" = ${entitySchema.enum.product} AND ${notDeleted(otherIdentifier)}
          JOIN "Product" c ON c.id = other."entityId" AND ${notDeleted(candidateProduct)}
      ) SELECT s.id AS "sourceId", s.name AS "sourceName", e.candidate AS "candidateId" FROM sources s LEFT JOIN edges e ON e.source = s.id AND e.source <> e.candidate ORDER BY s.id, e.candidate
    `),
      ).rows;
    for (const edge of edges) {
      const id = parseEntityId("product", edge.sourceId);
      seeds.set(id, { id, name: edge.sourceName });
      if (isMiscProduct(edge.sourceName)) continue;
      const ids = idsBySource.get(id) ?? new Set<ProductId>();
      if (edge.candidateId) ids.add(parseEntityId("product", edge.candidateId));
      idsBySource.set(id, ids);
    }
    const eligible = [...idsBySource.keys()];
    // Registered bindings for the sources and every retained-claim namespace
    // share one indexed read; never query once per retained own claim.
    const retainedKeys = new Set(claims.map(identifierKey));
    const registered = await client
      .select({
        productId: entityExternalId.entityId,
        source: entityExternalId.source,
        kind: entityExternalId.kind,
        value: entityExternalId.externalId,
      })
      .from(entityExternalId)
      .innerJoin(
        product,
        and(eq(product.id, entityExternalId.entityId), notDeleted(product)),
      )
      .where(
        and(
          eq(entityExternalId.entityKind, "product"),
          notDeleted(entityExternalId),
          claims.length
            ? sql`(${inArray(entityExternalId.entityId, eligible)} OR (${entityExternalId.source}, ${entityExternalId.kind}, ${entityExternalId.externalId}) IN (${sql.join(
                [
                  ...new Map(
                    claims.map((claim) => [identifierKey(claim), claim]),
                  ).values(),
                ].map(
                  (claim) =>
                    sql`(${claim.source}, ${claim.kind}, ${claim.value})`,
                ),
                sql`, `,
              )}))`
            : inArray(entityExternalId.entityId, eligible),
        ),
      );
    const ownersByIdentifier = new Map<string, Set<ProductId>>();
    const knownBySource = new Map<ProductId, Set<string>>();
    for (const claim of [...claims, ...registered]) {
      const id = parseEntityId("product", claim.productId);
      const key = identifierKey(claim);
      if (retainedKeys.has(key)) {
        const owners = ownersByIdentifier.get(key) ?? new Set<ProductId>();
        owners.add(id);
        ownersByIdentifier.set(key, owners);
      }
      if (idsBySource.has(id)) {
        const known = knownBySource.get(id) ?? new Set<string>();
        known.add(key);
        knownBySource.set(id, known);
      }
    }
    for (const [id, keys] of knownBySource)
      for (const key of keys)
        for (const owner of ownersByIdentifier.get(key) ?? [])
          idsBySource.get(id)?.add(owner);
  }
  for (const seed of seeds.values()) {
    const ids = idsBySource.get(seed.id) ?? new Set<ProductId>();
    const coverage: ProductIdentityRetrievalCoverage = {
      droppedClaims: [...droppedClaims],
      semanticNeighbours: { status: "unconfigured" },
    };
    results.set(seed.id, {
      eligible: !isMiscProduct(seed.name),
      candidates: [...ids].filter((other) => other !== seed.id).sort(),
      coverage,
    });
  }
  if (semanticEmbeddingsConfigured()) {
    const semantic = await retrieveProductIdentitySemanticPage(db, [
      ...idsBySource.keys(),
    ]);
    for (const [id, scan] of semantic) {
      const source = results.get(id);
      if (!source) continue;
      source.coverage.semanticNeighbours = scan.coverage;
      source.candidates = [
        ...new Set([...source.candidates, ...scan.candidates]),
      ]
        .filter((other) => other !== id)
        .sort();
    }
  }
  return { sources: results, claims };
}
/** Local semantic artifacts and live text are validated once for the corpus.
 * Only vector transport fans out, in waves of four; a failed seed retains its
 * own coverage error and cannot hide exact or lexical candidates.
 */
async function retrieveProductIdentitySemanticPage(
  db: Database,
  ids: readonly ProductId[],
) {
  const result = new Map<
    ProductId,
    {
      candidates: ProductId[];
      coverage: ProductIdentityRetrievalCoverage["semanticNeighbours"];
    }
  >();
  if (!ids.length) return result;
  try {
    const config = getSemanticEmbeddingConfig(),
      client = getDb(db);
    const rows = await client
      .select({
        id: entityEmbedding.id,
        entityKind: entityEmbedding.entityKind,
        entityId: entityEmbedding.entityId,
        hash: entityEmbedding.artifactHash,
        vectorHash: entityEmbedding.vectorHash,
      })
      .from(entityEmbedding)
      .innerJoin(
        searchDocument,
        and(
          eq(searchDocument.entityKind, entityEmbedding.entityKind),
          eq(searchDocument.entityId, entityEmbedding.entityId),
        ),
      )
      .innerJoin(
        entityIdentity,
        and(
          eq(entityIdentity.id, entityEmbedding.entityId),
          eq(entityIdentity.kind, entityEmbedding.entityKind),
        ),
      )
      .where(
        and(
          eq(entityEmbedding.entityKind, "product"),
          eq(entityEmbedding.artifactState, "selected"),
          isNull(entityEmbedding.deletedAt),
          isNotNull(entityEmbedding.observedAt),
          isNotNull(entityEmbedding.indexedAt),
          isNotNull(entityEmbedding.artifactHash),
          isNotNull(entityEmbedding.vectorHash),
          eq(entityEmbedding.provider, config.provider),
          eq(entityEmbedding.model, config.model),
          eq(entityEmbedding.dimensions, config.dimensions),
          isNull(searchDocument.deletedAt),
          isNull(entityIdentity.deletedAt),
        ),
      );
    const documents = await prepareSearchDocuments(db, rows);
    const textById = new Map(
      documents.entries.map(({ source, body }) => [source.entityId, body]),
    );
    const current = [];
    for (const row of rows) {
      const text = textById.get(row.entityId);
      if (
        text !== undefined &&
        row.hash ===
          (await embeddingTextHash({
            entityKind: row.entityKind,
            ...config,
            text: normalizeSearchText(text),
          }))
      )
        current.push(row);
    }
    const byEntity = new Map(current.map((row) => [row.entityId, row])),
      byArtifact = new Map(current.map((row) => [row.id, row]));
    const observations = await productionVectorStore.getByIds(
      ids.flatMap((id) => {
        const row = byEntity.get(id);
        return row ? [row.id] : [];
      }),
    );
    const observed = new Map(observations.map((row) => [row.id, row]));
    // The shared coverage probe includes direct and fanout dirty marks.
    const missing = await searchCoverageIncomplete(db, config, ["product"]);
    for (const wave of chunk(ids, 4))
      await Promise.all(
        wave.map(async (id) => {
          try {
            const selected = byEntity.get(id),
              vector = selected ? observed.get(selected.id) : undefined;
            if (
              !selected ||
              !vector ||
              vector.values.length !== config.dimensions ||
              (await vectorPayloadHash(vector.values)) !== selected.vectorHash
            ) {
              result.set(id, {
                candidates: [],
                coverage: {
                  status: "failed",
                  error: "Semantic candidate coverage is pending or incomplete",
                },
              });
              return;
            }
            const raw = await productionVectorStore.queryById(selected.id, {
              entityKinds: ["product"],
              topK: 100,
            });
            const candidates = [
              ...new Set(
                raw.flatMap((match) => {
                  const row = byArtifact.get(match.id);
                  return row && row.entityId !== id
                    ? [parseEntityId("product", row.entityId)]
                    : [];
                }),
              ),
            ];
            const complete =
              !missing && !(raw.length === 100 && candidates.length < 20);
            result.set(id, {
              candidates: candidates.slice(0, 20),
              coverage: complete
                ? { status: "queried", count: Math.min(20, candidates.length) }
                : {
                    status: "failed",
                    error:
                      "Semantic candidate coverage is pending or incomplete",
                  },
            });
          } catch (error) {
            result.set(id, {
              candidates: [],
              coverage: { status: "failed", error: getErrorMessage(error) },
            });
          }
        }),
      );
  } catch (error) {
    for (const id of ids)
      result.set(id, {
        candidates: [],
        coverage: { status: "failed", error: getErrorMessage(error) },
      });
  }
  return result;
}

export async function retrieveProductIdentityCandidates(
  db: Database,
  id: ProductId,
) {
  return (
    (await retrieveProductIdentityCandidatePage(db, [id])).sources.get(id) ?? {
      eligible: false,
      candidates: [],
      coverage: {
        droppedClaims: [],
        semanticNeighbours: { status: "unconfigured" as const },
      },
    }
  );
}

export type ProductIdentityPageTarget =
  | { key: string; kind: "product"; recordId: ProductId }
  | {
      key: string;
      kind: "product_pair";
      recordId: ProductId;
      otherId: ProductId;
    };
export type PreparedProductIdentityPageOutcome = {
  key: string;
  eligible: boolean;
  valid: boolean;
  fence: string;
  productIds: readonly [ProductId] | ProductIdentityPairIds;
  pairs: z.infer<typeof preparedProductIdentityPair>[];
  pairFences: Map<string, string>;
  coverage: ProductIdentityRetrievalCoverage | null;
};

/** Fixed set-read pipeline; no transaction survives preparation or inference.
 * Pair candidates receive their own brackets, independent of source/sibling
 * evidence. Retained claims are reloaded after that bracket because candidate
 * discovery must not authorize a stale candidate snapshot.
 */
export async function prepareProductIdentityPage(
  db: Database,
  targets: readonly ProductIdentityPageTarget[],
): Promise<PreparedProductIdentityPageOutcome[]> {
  if (isTransaction(getDb(db)))
    throw new Error(
      "Product identity page preparation requires a database outside a transaction",
    );
  if (!targets.length) return [];
  const sourceTargets: ProductIdentityFenceTarget[] = targets.map((target) => ({
    key: target.key,
    productIds:
      target.kind === "product"
        ? [target.recordId]
        : [target.recordId, target.otherId],
  }));
  const before = await productIdentityEvidenceFences(db, sourceTargets);
  const sources = targets.flatMap((target) =>
    target.kind === "product" ? [target.recordId] : [],
  );
  const retrieval = sources.length
    ? await retrieveProductIdentityCandidatePage(db, sources)
    : null;
  const pairIds = new Map<string, ProductIdentityPairIds>();
  for (const target of targets) {
    const ids: ProductIdentityPairIds[] =
      target.kind === "product_pair"
        ? [[target.recordId, target.otherId]]
        : (retrieval?.sources.get(target.recordId)?.candidates ?? []).map(
            (other) => [target.recordId, other],
          );
    for (const pair of ids) pairIds.set(productIdentityPairKey(pair), pair);
  }
  const pairTargets = [...pairIds].map(([key, productIds]) => ({
    key: `pair:${key}`,
    productIds,
  }));
  const pairBefore = pairTargets.length
    ? await productIdentityEvidenceFences(db, pairTargets)
    : new Map<string, string>();
  const snapshots = await productIdentitySnapshots(db, [
    ...sources,
    ...[...pairIds.values()].flatMap((ids) => [...ids]),
  ]);
  const pairs = await productIdentityPairsFromSnapshots(
    db,
    [...pairIds.values()],
    snapshots,
  );
  const after = await productIdentityEvidenceFences(db, [
    ...sourceTargets,
    ...pairTargets,
  ]);
  return targets.map((target) => {
    const targetPairKeys =
      target.kind === "product_pair"
        ? [productIdentityPairKey([target.recordId, target.otherId])]
        : (retrieval?.sources.get(target.recordId)?.candidates ?? []).map(
            (other) => productIdentityPairKey([target.recordId, other]),
          );
    const prepared = targetPairKeys.flatMap((key) => {
      const pair = pairs.get(key);
      return pair ? [pair] : [];
    });
    return {
      key: target.key,
      eligible:
        snapshots.get(target.recordId)?.eligible === true &&
        (target.kind === "product" || prepared.length > 0),
      valid:
        before.get(target.key) === after.get(target.key) &&
        targetPairKeys.every(
          (key) => pairBefore.get(`pair:${key}`) === after.get(`pair:${key}`),
        ),
      fence: before.get(target.key) ?? "",
      productIds:
        target.kind === "product"
          ? [target.recordId]
          : [target.recordId, target.otherId],
      pairs: prepared,
      pairFences: new Map(
        targetPairKeys.map((key) => [key, pairBefore.get(`pair:${key}`) ?? ""]),
      ),
      coverage: retrieval?.sources.get(target.recordId)?.coverage ?? null,
    };
  });
}
/** Adapter-facing publication: explicit per-target validity, no transaction owner. */
export function publishProductIdentityChunk(
  tx: Database,
  outcomes: readonly PreparedProductPairPublication[],
): Promise<ProductPairPublicationResult[]> {
  return publishProductPairPublications(tx, outcomes);
}

async function prepareProductIdentityCatalog(db: Database, id: ProductId) {
  const { eligible, candidates, coverage } =
    await retrieveProductIdentityCandidates(db, id);
  // Candidate retrieval already read the source name and deletion state.
  if (!eligible) return { eligible: false, pairs: [], coverage: null };
  const pairs = await prepareProductIdentityPairs(
    db,
    candidates.map((other) => [id, other]),
  );
  return {
    eligible: true,
    pairs: [...pairs.values()],
    coverage,
  };
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
    usage?: Parameters<typeof runDecisionChoice>[0]["usage"];
    preparedPage?: boolean;
  } = {},
) {
  const pair = preparedProductIdentityPair.parse(raw);
  const current = options.preparedPage
    ? pair
    : await prepareProductIdentityPair(db, pair.productIds);
  return evaluateCurrentProductIdentityPair(db, pair, current, runId, options);
}

async function evaluateCurrentProductIdentityPair(
  db: Database,
  pair: z.infer<typeof preparedProductIdentityPair>,
  current: z.infer<typeof preparedProductIdentityPair> | null,
  runId: RunId,
  options: NonNullable<
    Parameters<typeof evaluatePreparedProductIdentityPair>[3]
  >,
) {
  const question = {
    ...productIdentityPrompt(JSON.stringify([pair.first, pair.second])),
    feature: PRODUCT_IDENTITY_FEATURE,
    decisionModel:
      options.model == null
        ? undefined
        : supportedDecisionModelSchema.parse(options.model),
    port: options.decisionPort,
    usage: options.usage ?? { db, runId, operation: "product-identity" },
  };
  const model = decisionModelFor(question);
  if (!current || current.fingerprint !== pair.fingerprint)
    throw new Error("Product identity evidence changed during evaluation");
  const decision = pair.exact
    ? null
    : await runDecisionChoice({
        ...question,
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
  > & { preparedCatalog?: PreparedProductIdentityPageOutcome } = {},
) {
  const prepared =
    ports.preparedCatalog ?? (await prepareProductIdentityCatalog(db, id));
  if (
    "valid" in prepared &&
    (!prepared.valid ||
      prepared.productIds.length !== 1 ||
      prepared.productIds[0] !== id)
  )
    throw new Error("Product identity catalog changed during preparation");
  const pairs = [];
  let failure: string | null = null;
  const usage = ports.usage ?? { db, runId, operation: "product-identity" };
  const settled = await evaluatePreparedProductIdentityPairs(
    db,
    prepared.pairs,
    runId,
    { ...ports, usage },
  );
  for (const result of settled) {
    if (result.status === "fulfilled") pairs.push(result.value);
    else failure = getErrorMessage(result.reason);
  }
  return { eligible: prepared.eligible, pairs, failure };
}

/** Recheck all pair inputs once immediately before the decision wave. */
async function evaluatePreparedProductIdentityPairs(
  db: Database,
  pairs: readonly z.infer<typeof preparedProductIdentityPair>[],
  runId: RunId,
  options: NonNullable<
    Parameters<typeof evaluatePreparedProductIdentityPair>[3]
  > = {},
) {
  const current = await prepareProductIdentityPairs(
    db,
    pairs.map((pair) => pair.productIds),
  );
  return settleDecisionWorkItems(
    pairs.map((pair) => ({
      pair,
      current: current.get(productIdentityPairKey(pair.productIds)) ?? null,
    })),
    ({ pair, current }) =>
      evaluateCurrentProductIdentityPair(db, pair, current, runId, options),
  );
}
