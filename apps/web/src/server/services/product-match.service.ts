import type { ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  parseShortcodeFor,
  type ProductId,
  type ProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";
import type {
  dismissProductMatchInput,
  mergeProductMatchInput,
  ProductMatchCandidate,
  ProductMatchQueueOut,
  proposeProductMatchInput,
  proposeProductMatchOut,
} from "@cubby/schemas/recommendations";
import { getErrorMessage } from "@cubby/shared";
import { createLogger } from "@cubby/worker-tracing";
import { chunk } from "es-toolkit";
import type { z } from "zod";

import type { AiRunContext } from "~/server/ai/run-feature";
import { decideProductVariantComparison } from "~/server/ai/semantic-decisions";
import type { Database } from "~/server/db";
import {
  type EntityKernelContext,
  executeEntity,
  executeEntityAs,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";
import { findSimilarEntities } from "~/server/repo/entity-embedding";
import {
  type LoadedMatchSide,
  loadProductImageOrderFacts,
  loadProductMatchPools,
  loadProductMatchSides,
} from "~/server/repo/product-match";
import {
  dismissProductMatch,
  listProductMatchRows,
  productPairKey,
  upsertAgentProductMatch,
} from "~/server/repo/product-match-candidate";
import { unknownProductVariantComparison } from "~/server/repo/product-variant-comparison";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { ensureRun, aiCallRunInput } from "~/server/runs/ensure-run";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/semantic/vector-store";
import { traceAllBounded } from "~/server/tracing";

import {
  describeSignals,
  matchReadCoverage,
  type MatchSignals,
  sharesModel,
  matchSurvivorImageOrder,
  pairByModel,
  pairByNameTokens,
  rankMatches,
} from "./product-match-ranking";

const log = createLogger("product-match");

/** Bounds that keep one queue read to a fixed number of vector lookups. */
const TOKEN_CANDIDATES_PER_PHOTO = 10;
const SEMANTIC_SEEDS = 60;
const SEMANTIC_NEIGHBOURS = 20;
const SEMANTIC_CONCURRENCY = 6;
const PRELIMINARY_PER_PHOTO = 5;
const FINAL_PER_PHOTO = 3;
const QUEUE_LIMIT = 100;
const VARIANT_DECISION_LIMIT = 100;

const BOTH_STOCKED_WARNING =
  "Both products have stock. Merging sums their quantities, so delete the duplicate stock entry first.";

export interface ProductMatchDependencies {
  vectorStore: VectorStorePort;
  semanticConfigured: () => boolean;
  decideVariant?: typeof decideProductVariantComparison;
}

const productionProductMatchDependencies: ProductMatchDependencies = {
  vectorStore: productionVectorStore,
  semanticConfigured: () => semanticEmbeddingsConfigured(),
};

type Pools = Awaited<ReturnType<typeof loadProductMatchPools>>;
type SemanticPair = {
  photoId: ProductId;
  purchaseId: ProductId;
  similarity: number;
};

/** Nearest product neighbours of each seed, oriented photo → purchase. */
async function semanticSignals(
  deps: ProductMatchDependencies,
  pools: Pools,
  seeds: readonly ProductId[],
): Promise<{ used: boolean; pairs: Map<string, SemanticPair> }> {
  const pairs = new Map<string, SemanticPair>();
  if (seeds.length === 0 || !deps.semanticConfigured())
    return { used: false, pairs };
  const photo = new Set(pools.photo.map((item) => item.id));
  const purchase = new Set(pools.purchase.map((item) => item.id));
  try {
    for (const batch of chunk([...seeds], SEMANTIC_CONCURRENCY)) {
      const results = await Promise.all(
        batch.map(async (seed) => ({
          seed,
          neighbours: await findSimilarEntities(
            deps.vectorStore,
            { entityKind: "product", entityId: seed },
            { targetType: "product", limit: SEMANTIC_NEIGHBOURS },
          ),
        })),
      );
      for (const { seed, neighbours } of results) {
        for (const neighbour of neighbours) {
          const other = parseEntityId("product", neighbour.entityId);
          const [photoId, purchaseId] =
            photo.has(seed) && purchase.has(other)
              ? [seed, other]
              : purchase.has(seed) && photo.has(other)
                ? [other, seed]
                : [null, null];
          if (!photoId || !purchaseId) continue;
          const key = `${photoId}|${purchaseId}`;
          const similarity = Math.max(
            pairs.get(key)?.similarity ?? -Infinity,
            neighbour.similarity,
          );
          pairs.set(key, { photoId, purchaseId, similarity });
        }
      }
    }
    return { used: true, pairs };
  } catch (error) {
    // The queue must still work from names alone when the index is down.
    log.warn("semantic failed", {
      message: getErrorMessage(error),
    });
    return { used: false, pairs: new Map() };
  }
}

/** Keeper first: the purchase side carries the spend and order history. */
function orient(
  a: LoadedMatchSide,
  b: LoadedMatchSide,
): [LoadedMatchSide, LoadedMatchSide] {
  if (a.role === "purchase" && b.role !== "purchase") return [a, b];
  if (b.role === "purchase" && a.role !== "purchase") return [b, a];
  return [a, b];
}

const publicSide = ({
  entityId: _entityId,
  rootCategoryId: _rootCategoryId,
  ownerPartyId: _ownerPartyId,
  ...side
}: LoadedMatchSide) => side;

function candidate(
  source: ProductMatchCandidate["source"],
  a: LoadedMatchSide,
  b: LoadedMatchSide,
  details: Pick<ProductMatchCandidate, "evidence" | "sourceUrls" | "signals">,
  variant: ProductVariantComparison,
): ProductMatchCandidate {
  const [keeper, other] = orient(a, b);
  const variantWarnings = [variant.color, variant.size].flatMap(
    (fact, index) =>
      fact.relation === "different"
        ? [
            `Product titles conflict on ${index === 0 ? "color" : "size"}; check the photos and label before merging.`,
          ]
        : [],
  );
  return {
    source,
    keeper: publicSide(keeper),
    other: publicSide(other),
    ...details,
    variant,
    warnings: [
      ...variantWarnings,
      keeper.inventoryCount > 0 && other.inventoryCount > 0
        ? BOTH_STOCKED_WARNING
        : null,
    ].filter((warning): warning is string => warning !== null),
  };
}

function variantComparisonKey(a: LoadedMatchSide, b: LoadedMatchSide): string {
  return productPairKey(a.entityId, b.entityId);
}

async function inferVariantComparisons(
  db: Database,
  actorContext: ActorContext,
  pairs: readonly (readonly [LoadedMatchSide, LoadedMatchSide])[],
  decideVariant: typeof decideProductVariantComparison = decideProductVariantComparison,
): Promise<Map<string, ProductVariantComparison>> {
  const unique = new Map<string, readonly [LoadedMatchSide, LoadedMatchSide]>();
  for (const [a, b] of pairs.slice(0, VARIANT_DECISION_LIMIT)) {
    const key = variantComparisonKey(a, b);
    if (!unique.has(key)) unique.set(key, [a, b]);
  }
  if (unique.size === 0) return new Map();
  const runId = await ensureRun(db, actorContext, aiCallRunInput(actorContext));
  const usage: AiRunContext = {
    db,
    runId,
    operation: "product-match.variant-comparison",
  };
  const tasks: Record<string, () => Promise<ProductVariantComparison>> =
    Object.fromEntries(
      [...unique].map(([key, [a, b]]) => {
        const [first, second] = orient(a, b);
        return [
          key,
          () =>
            decideVariant({
              firstTitle: first.name,
              secondTitle: second.name,
              usage,
            }),
        ];
      }),
    );
  return new Map(
    Object.entries(
      await traceAllBounded(tasks, 3, {
        spanName: "product-match.variant-comparison",
      }),
    ),
  );
}

function variantFor(
  comparisons: ReadonlyMap<string, ProductVariantComparison>,
  a: LoadedMatchSide,
  b: LoadedMatchSide,
): ProductVariantComparison {
  const [first, second] = orient(a, b);
  return (
    comparisons.get(variantComparisonKey(a, b)) ??
    unknownProductVariantComparison(first.name, second.name)
  );
}

async function getDirectedProductMatchQueue(
  db: Database,
  input: { productId: ProductShortcode; candidateId: ProductShortcode },
  actorContext: ActorContext,
  deps: ProductMatchDependencies,
): Promise<ProductMatchQueueOut> {
  const [sourceId, candidateId] = await resolvePair(db, [
    input.productId,
    input.candidateId,
  ]);
  const [rows, sides] = await Promise.all([
    listProductMatchRows(db),
    loadProductMatchSides(db, [sourceId, candidateId]),
  ]);
  const existing = rows.find(
    (row) =>
      productPairKey(row.productAId, row.productBId) ===
      productPairKey(sourceId, candidateId),
  );
  const source = sides.get(sourceId);
  const match = sides.get(candidateId);
  const comparisons =
    source && match && existing?.state !== "dismissed"
      ? await inferVariantComparisons(
          db,
          actorContext,
          [[source, match]],
          deps.decideVariant,
        )
      : new Map<string, ProductVariantComparison>();
  return {
    semanticRanking: false,
    items:
      source && match && existing?.state !== "dismissed"
        ? [
            candidate(
              existing?.source ?? "detector",
              source,
              match,
              {
                evidence: existing?.evidence ?? null,
                sourceUrls: existing?.sourceUrls ?? [],
                signals: existing ? [] : ["Suggested from photo review"],
              },
              variantFor(comparisons, source, match),
            ),
          ]
        : [],
  };
}

/** Open agent proposals first, then the detector's live photo × purchase pairs. */
export async function getProductMatchQueue(
  db: Database,
  input: { productId?: ProductShortcode; candidateId?: ProductShortcode },
  deps: ProductMatchDependencies = productionProductMatchDependencies,
  actorContext: ActorContext,
): Promise<ProductMatchQueueOut> {
  if (input.productId && input.candidateId)
    return getDirectedProductMatchQueue(
      db,
      {
        productId: input.productId,
        candidateId: input.candidateId,
      },
      actorContext,
      deps,
    );
  const startedAt = Date.now();
  const focus = input.productId
    ? await resolveOrThrow(db, "product", input.productId)
    : undefined;
  const [rows, pools] = await Promise.all([
    listProductMatchRows(db),
    loadProductMatchPools(db),
  ]);
  const stored = new Set(
    rows.map((row) => productPairKey(row.productAId, row.productBId)),
  );
  const involves = (a: string, b: string) =>
    focus === undefined || a === focus || b === focus;

  const photoPool = focus
    ? pools.photo.filter((item) => item.id === focus)
    : pools.photo;
  const purchasePool =
    focus && !photoPool.length
      ? pools.purchase.filter((item) => item.id === focus)
      : pools.purchase;
  const tokenPairs = pairByNameTokens(
    focus && !photoPool.length ? pools.photo : photoPool,
    purchasePool,
    TOKEN_CANDIDATES_PER_PHOTO,
  );
  const seeds = focus
    ? [focus]
    : [...pools.photo]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, SEMANTIC_SEEDS)
        .map((item) => item.id);
  const semantic = await semanticSignals(deps, pools, seeds);

  const root = new Map(
    [...pools.photo, ...pools.purchase].map((item) => [
      item.id,
      item.rootCategoryId,
    ]),
  );
  const byId = new Map(
    [...pools.photo, ...pools.purchase].map((item) => [item.id, item]),
  );
  const signals = new Map<string, MatchSignals<ProductId>>();
  const upsert = (
    photoId: ProductId,
    purchaseId: ProductId,
    patch: Partial<MatchSignals<ProductId>>,
  ) => {
    const key = `${photoId}|${purchaseId}`;
    const photoRoot = root.get(photoId) ?? null;
    const purchaseRoot = root.get(purchaseId) ?? null;
    signals.set(key, {
      photoId,
      purchaseId,
      sharedTokens: [],
      overlap: 0,
      similarity: semantic.pairs.get(key)?.similarity ?? null,
      sameCategory:
        photoRoot && purchaseRoot ? photoRoot === purchaseRoot : null,
      sameOwner: null,
      sameModel:
        byId.has(photoId) && byId.has(purchaseId)
          ? sharesModel(byId.get(photoId)!, byId.get(purchaseId)!)
          : false,
      ...signals.get(key),
      ...patch,
    });
  };
  for (const pair of tokenPairs)
    upsert(pair.photoId, pair.purchaseId, {
      sharedTokens: pair.sharedTokens,
      overlap: pair.overlap,
    });
  for (const { photoId, purchaseId } of semantic.pairs.values())
    upsert(photoId, purchaseId, {});
  for (const { photoId, purchaseId } of pairByModel(
    focus && !photoPool.length ? pools.photo : photoPool,
    purchasePool,
  ))
    upsert(photoId, purchaseId, {});
  const detector = [...signals.values()].filter(
    (item) =>
      !stored.has(productPairKey(item.photoId, item.purchaseId)) &&
      involves(item.photoId, item.purchaseId),
  );
  const preliminary = rankMatches(detector, PRELIMINARY_PER_PHOTO);

  const openAgent = rows
    .filter(
      (row) =>
        row.state === "open" &&
        row.source === "agent" &&
        involves(row.productAId, row.productBId),
    )
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, QUEUE_LIMIT);
  const sides = await loadProductMatchSides(db, [
    ...preliminary.flatMap((item) => [item.photoId, item.purchaseId]),
    ...openAgent.flatMap((row) => [row.productAId, row.productBId]),
  ]);

  const withOwners = preliminary.map((item) => {
    const photoOwner = sides.get(item.photoId)?.ownerPartyId;
    const purchaseOwner = sides.get(item.purchaseId)?.ownerPartyId;
    return {
      ...item,
      sameOwner:
        photoOwner && purchaseOwner ? photoOwner === purchaseOwner : null,
    };
  });
  const finalDetector = rankMatches(withOwners, FINAL_PER_PHOTO);
  const comparisonPairs = [
    ...openAgent.flatMap((row) => {
      const a = sides.get(row.productAId);
      const b = sides.get(row.productBId);
      return a && b ? [[a, b] as const] : [];
    }),
    ...finalDetector.flatMap((item) => {
      const photo = sides.get(item.photoId);
      const purchase = sides.get(item.purchaseId);
      return photo && purchase ? [[purchase, photo] as const] : [];
    }),
  ];
  const comparisons = await inferVariantComparisons(
    db,
    actorContext,
    comparisonPairs,
    deps.decideVariant,
  );
  const agentItemsWithVariants = openAgent.flatMap((row) => {
    const a = sides.get(row.productAId);
    const b = sides.get(row.productBId);
    return a && b
      ? [
          candidate(
            "agent",
            a,
            b,
            { evidence: row.evidence, sourceUrls: row.sourceUrls, signals: [] },
            variantFor(comparisons, a, b),
          ),
        ]
      : [];
  });
  const detectorItems = finalDetector.flatMap((item) => {
    const photo = sides.get(item.photoId);
    const purchase = sides.get(item.purchaseId);
    return photo && purchase
      ? [
          candidate(
            "detector",
            purchase,
            photo,
            {
              evidence: null,
              sourceUrls: [],
              signals: describeSignals(item),
            },
            variantFor(comparisons, purchase, photo),
          ),
        ]
      : [];
  });
  const items = [...agentItemsWithVariants, ...detectorItems].slice(
    0,
    QUEUE_LIMIT,
  );
  if (!focus)
    log.info("queue read coverage", {
      ...matchReadCoverage({
        photoIds: pools.photo.map((item) => item.id),
        purchaseCount: pools.purchase.length,
        seeds,
        semanticUsed: semantic.used,
        pairs: [
          ...tokenPairs.map((pair) => ({ ...pair, source: "token" as const })),
          ...[...semantic.pairs.values()].map((pair) => ({
            ...pair,
            source: "semantic" as const,
          })),
        ],
        returned: items.length,
        queueLimit: QUEUE_LIMIT,
      }),
      elapsedMs: Date.now() - startedAt,
    });
  return { semanticRanking: semantic.used, items };
}

async function resolvePair(
  db: Database,
  productIds: readonly ProductShortcode[],
): Promise<[ProductId, ProductId]> {
  const [a, b] = productIds;
  if (!a || !b || a === b)
    throw createAppError(
      "MERGE_SELF_REFERENCE",
      "A product match needs two different products",
    );
  return [
    await resolveOrThrow(db, "product", a),
    await resolveOrThrow(db, "product", b),
  ];
}

export async function proposeProductMatch(
  db: Database,
  input: z.output<typeof proposeProductMatchInput>,
): Promise<z.output<typeof proposeProductMatchOut>> {
  const pair = await resolvePair(db, input.productIds);
  const row = await upsertAgentProductMatch(db, {
    productIds: pair,
    evidence: input.evidence,
    sourceUrls: input.sourceUrls ?? [],
  });
  return {
    productIds: [...input.productIds],
    source: row.source,
    state: row.state,
    evidence: row.evidence,
    sourceUrls: row.sourceUrls,
    created: row.created,
  };
}

export async function dismissProductMatchPair(
  db: Database,
  input: z.output<typeof dismissProductMatchInput>,
): Promise<{ ok: true }> {
  await dismissProductMatch(db, await resolvePair(db, input.productIds));
  return { ok: true };
}

/**
 * Merge through the ordinary entity kernel (so every merge refusal, audit, and
 * edge policy applies unchanged — including discarding this pair's review
 * row), then reorder the survivor's covers: own photo → catalogue → label.
 * The generic merge deliberately keeps survivor-first image order; only a
 * photo/purchase match knows the photo should lead.
 */
export async function mergeProductMatch(
  context: EntityKernelContext,
  input: z.output<typeof mergeProductMatchInput>,
) {
  await executeEntityAs(context, "merge", {
    entity: "product",
    data: { keepId: input.keepId, mergeIds: [input.mergeId] },
  });
  const keepId = await resolveOrThrow(context.db, "product", input.keepId);
  const images = await loadProductImageOrderFacts(context.db, keepId);
  const ordered = matchSurvivorImageOrder(images);
  if (ordered.some((item, index) => item !== images[index])) {
    await executeEntity(context, {
      action: "update",
      entity: "product",
      id: input.keepId,
      data: {
        imageOrder: ordered.map((item) =>
          parseShortcodeFor("image", item.shortcode),
        ),
      },
    });
  }
  return { ok: true as const };
}
