/**
 * Problems Service
 *
 * Orchestrates the Problems-page detectors. This is the layer that mixes repos
 * with other services:
 * - USDA enrichment (batchEnrichWithFood) for the coverage / islanding detectors
 * - cross-entity deletes (products + ingredients) with audit logging
 * - the re-parse mutation (find-or-create ingredient + transactional writes)
 * - the full findAllProblems / findMaintenanceCounts scans that fan out over the
 *   repo-layer detectors
 *
 * Pure detection/query helpers (all DB + WASM access) live in
 * ~/server/repo/problems; this service composes them — it never touches the DB
 * directly (enforced by the services-layer noRestrictedImports rule).
 */

import type { ActorContext } from "@cubby/schemas/context";
import {
  type IngredientId,
  type ProductId,
  type RecipeId,
  unsafeIngredientId,
  unsafeIngredientShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { CULL_PENDING_IMAGES_DEFAULT_HOURS } from "@cubby/schemas/image";
import {
  type AllProblems,
  assembleAllProblems,
  type CoverageTotals,
  type IngredientWithPartialCoverage,
  type MaintenanceCounts,
  type ProblemKey,
  type ProblemsCount,
  type ProblemsCoverage,
  type ProblemsFast,
  type ProblemsTracker,
  type ProblemsUpc,
  type ProductWithBetterUpcData,
  type ProductWithIslandedMappings,
  type ProductWithTitleDerivableSize,
} from "@cubby/schemas/problems";
import type { ProjectAttentionItem } from "@cubby/schemas/project";
import { isMiscProduct, isNonFoodCategory } from "@cubby/shared";
import { sum, uniq, uniqBy } from "es-toolkit";
import { problemQueryDeclarations } from "~/entities/problem-registry";
import {
  BASE_KINDS,
  conversionCoverage,
  gradedKinds,
} from "~/lib/conversion-coverage";
import { getErrorMessage } from "~/lib/error-utils";
import { isMoneyUnit } from "~/lib/price-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import { type Database, withConnection } from "~/server/db";
import {
  findOrphanedEntityEmbeddings,
  softDeleteEntityEmbeddingRows,
} from "~/server/repo/entity-embedding";
import {
  countCullablePendingImages,
  countUnreferencedImages,
} from "~/server/repo/image";
import {
  deleteIngredients,
  findOrCreateIngredient,
} from "~/server/repo/ingredient";
import {
  applyReparsedStaleLines,
  countEntitiesMissingEmbeddings,
  countReparseableLines,
  findCoverageTotals as findCoverageTotalsRepo,
  findIngredientsWithUnusedAliases,
  findLinkedProductIds,
  findStaleIngredientParses,
  loadAllocationDefectPresenters,
  loadProductsForCoverage,
  loadSoldButStockedPresenterTotals,
  loadVendorLogoPresenterCounts,
  pruneUnusedAliases,
  type ReparsedStaleLineWrite,
  synthesizeEffectiveMappings,
} from "~/server/repo/problems";
import {
  deleteProducts,
  findProductsWithNoImages,
  getProductConversionCoverageFreshness,
  loadProductConversionCoverageProjection,
  type ProductConversionCoverageFreshness,
  type ProductConversionCoverageProjection,
  writeProductConversionCoverageProjection,
} from "~/server/repo/product";
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import { countStaleRecipeTotals } from "~/server/repo/recipe/totals";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import {
  type DiagnosticSampleResult,
  runDiagnostic,
} from "~/server/services/problem-diagnostics.service";
import {
  countViewProblem,
  executeProblem,
  findViewProblems,
} from "~/server/services/problem-views.service";
import { batchEnrichWithFood } from "~/server/services/usda-helpers";
import { traceAll, traceAllBounded } from "~/server/tracing";

// The embedding-coverage detector is gated HERE rather than in the repo, so the
// repo stays pure data access and the env read stays in the service layer.
//
// The gate itself is load-bearing: with no AI_GATEWAY_API_KEY every live row in
// every searchable table reads as "missing an embedding", and nothing can
// ever clear it — `enqueueEntityEmbeddingBackfill` doesn't check configuration
// either, so it would cheerfully enqueue thousands of jobs that all throw at
// `embedTexts`. Report nothing rather than an unfixable wall. Mirrors the
// degradation the semantic read paths already do.
const countMissingEmbeddings = async (db: Database) =>
  semanticEmbeddingsConfigured()
    ? countEntitiesMissingEmbeddings(db, getSemanticEmbeddingConfig())
    : 0;

// Detect both coverage problems in one pass: ingredient products that are
// *under-covered* and products whose mappings *island*. Both detectors fetch
// products with their stored mappings, enrich them with USDA food, and
// synthesize effective edges — so they share one product scan, one USDA
// enrichment (the overlap deduped by the client memo), and one synthesis per
// product instead of doing all of it twice. This is the perf win behind the
// always-on navbar badge: the scan POSTs to the USDA worker once, not twice.
//
//   - partial coverage: an ingredient product with *some* coverage (so
//     the product/unmapped view skips it) whose effective conversion graph
//     (stored conversions + price edge + USDA edges) still can't reach all four
//     base kinds. Money in a unit mapping counts like a scalar price.
//   - islanded mappings: a product whose *effective* mappings still split into
//     2+ components. A product islanded on its stored mappings alone but bridged
//     into one component by USDA portion/serving edges is fully convertible, so
//     it isn't flagged — mirroring the "a USDA link counts as coverage" rule in
//     the `product/unmapped` view.
const findProductCoverageProblems = async (
  db: Database,
  usdaClient: USDAClient,
): Promise<{
  ingredientsWithPartialCoverage: IngredientWithPartialCoverage[];
  productsWithIslandedMappings: ProductWithIslandedMappings[];
  projection: ProductConversionCoverageProjection[];
}> => {
  // One scan, a superset of both detectors' needs: all non-deleted products with
  // their stored mappings + the linked ingredient's N/A opt-outs.
  const products = await loadProductsForCoverage(db);

  // Candidate sets are pure DB/WASM (no network). Partial coverage wants
  // ingredient products with *some* signal — truly-empty ones belong to
  // the `product/unmapped` view. Islanded wants products whose STORED mappings
  // already split into 2+ components: adding the derived edges can only merge
  // components, never split them, so a product connected on its stored mappings
  // can never be islanded. detect_unit_mapping_islands is infallible (never throws).
  // Non-food (household/garage) products have no food-coverage meaning — exempt
  // them from both coverage detectors, matching the `product/unmapped` view.
  const partialCandidates = products.filter(
    (p) =>
      p.ingredientId != null &&
      !isMiscProduct(p.name) &&
      !isNonFoodCategory(p.category) &&
      (p.price != null ||
        p.fdc_id != null ||
        p.upc != null ||
        p.unitMappings.length > 0),
  );
  const islandedCandidates = products.filter(
    (p) =>
      p.unitMappings.length >= 2 &&
      !isMiscProduct(p.name) &&
      !isNonFoodCategory(p.category) &&
      wasm.detect_unit_mapping_islands(p.unitMappings).length >= 2,
  );

  // One USDA enrichment over the union of both candidate sets (the client memo
  // dedupes the overlap so each food is fetched once), then synthesize each
  // product's effective mappings once, keyed by id, for both detectors.
  const toEnrich = uniqBy(
    [...partialCandidates, ...islandedCandidates],
    (p) => p.id,
  );
  const enriched = await batchEnrichWithFood(
    toEnrich,
    foodLookupParamFromProduct,
    usdaClient,
  );
  const enrichedById = new Map(enriched.map((p) => [p.id, p]));
  const effectiveById = new Map(
    enriched.map((p) => [
      p.id,
      synthesizeEffectiveMappings({
        ...p,
        id: unsafeProductShortcode(p.shortcode),
      }),
    ]),
  );

  const ingredientsWithPartialCoverage: IngredientWithPartialCoverage[] = [];
  const projectionById = new Map<
    ProductId,
    ProductConversionCoverageProjection
  >(
    products.map((p) => [
      p.id,
      {
        productId: p.id,
        coverageTier: "none",
        coveredKinds: [],
        applicableKinds: [],
        islandCount: 0,
        status: "ready",
      },
    ]),
  );
  for (const cand of partialCandidates) {
    const p = enrichedById.get(cand.id);
    const effective = p ? effectiveById.get(p.id) : null;
    if (!p || !effective) {
      projectionById.set(cand.id, {
        ...projectionById.get(cand.id)!,
        status: "unavailable",
      });
      continue;
    }

    // partialCandidates guarantees ingredientId != null; narrow for the
    // non-nullable schema fields (the joined ingredient carries the shortcode
    // these rows link by).
    if (p.ingredientId == null || p.ingredient == null) continue;

    const applicable = gradedKinds(p.ingredient?.naKinds);
    const cov = conversionCoverage(effective, applicable);
    projectionById.set(p.id, {
      ...projectionById.get(p.id)!,
      coverageTier: cov.tier,
      coveredKinds: [...cov.covered],
      applicableKinds: [...applicable],
    });
    if (cov.tier === "complete") continue;

    // Flag any food whose effective graph can't reach all four base kinds. This
    // includes the subtle case where a scalar/each price exists but isn't
    // reachable from a measure (e.g. russet potato: `1 each = $1` islanded from
    // the gram graph because no portion maps `each`→g) — money stays uncovered.
    // `hasPrice` no longer exempts: a price you can't convert from a measure is
    // still a gap.
    const hasPrice =
      p.price != null ||
      effective.some((m) => isMoneyUnit(m.a.unit) || isMoneyUnit(m.b.unit));

    ingredientsWithPartialCoverage.push({
      id: unsafeProductShortcode(p.shortcode),
      name: p.name,
      manufacturer: p.manufacturer,
      coverage: { covered: [...cov.covered], applicable: [...applicable] },
      hasPrice,
      hasUsdaLink: p.food != null,
      usdaUnavailable: p.usdaUnavailable ?? false,
      ingredientId: unsafeIngredientShortcode(p.ingredient.shortcode),
    });
  }

  const productsWithIslandedMappings: ProductWithIslandedMappings[] = [];
  for (const cand of islandedCandidates) {
    const p = enrichedById.get(cand.id);
    const effective = p ? effectiveById.get(p.id) : null;
    if (!p || !effective) {
      projectionById.set(cand.id, {
        ...projectionById.get(cand.id)!,
        status: "unavailable",
      });
      continue;
    }

    const islands = wasm.detect_unit_mapping_islands(effective);
    projectionById.set(p.id, {
      ...projectionById.get(p.id)!,
      islandCount: islands.length,
    });
    if (islands.length >= 2) {
      productsWithIslandedMappings.push({
        id: unsafeProductShortcode(p.shortcode),
        name: p.name,
        manufacturer: p.manufacturer,
        islandCount: islands.length,
        islands: islands.map((units) => ({
          units: units.slice(0, 3), // Limit to first 3 units for display
          exampleUnit: units[0] ?? "unknown",
        })),
        coverage: {
          covered: [...conversionCoverage(effective, BASE_KINDS).covered],
          // Islanding is about a disconnected money/measure component, not N/A
          // dimensions — grade against all four base kinds.
          applicable: [...BASE_KINDS],
        },
      });
    }
  }

  return {
    ingredientsWithPartialCoverage,
    productsWithIslandedMappings,
    projection: [...projectionById.values()],
  };
};

/** Rebuild the persisted list-query projection using this exact detector scan. */
export const rebuildProductConversionCoverageProjection = async (
  db: Database,
  usdaClient: USDAClient,
): Promise<ProductConversionCoverageProjection[]> => {
  const { projection } = await findProductCoverageProblems(db, usdaClient);
  await writeProductConversionCoverageProjection(db, projection);
  return projection;
};

// Apply the current parser's result to every stale ingredient line, persisting the
// fresh parse on all three axes (name, amounts, modifier). Reuses the exact scan the
// UI shows, so it fixes precisely the listed rows. Name drift re-points the ingredient
// FK via find-or-create; amounts/modifier are column writes. Idempotent — a second run
// finds nothing stale. Returns the affected recipe ids so the caller recomputes them.
export async function* reparseStaleIngredientParses(
  db: Database,
): AsyncGenerator<
  { done: number; total: number },
  { updated: number; recipesAffected: RecipeId[] }
> {
  const stale = await findStaleIngredientParses(db);
  if (stale.length === 0) {
    yield { done: 0, total: 0 };
    return { updated: 0, recipesAffected: [] };
  }
  // The row updates run in ONE transaction (kept atomic — partial reparse is
  // harmless but the single tx is cheap), so progress is coarse: 0 → all. We
  // yield only AROUND the tx, never inside it, so the tx isn't held open across
  // the stream.
  yield { done: 0, total: stale.length };

  // Resolve every drifted name up front, in parallel on the pool and deduped to
  // one find-or-create per distinct name. This pulls the ingredient lookups out
  // of the write transaction's serial critical path (Postgres runs one
  // statement at a time per connection, so the old interleaved
  // find-or-create + update was ~2N sequential round-trips). find-or-create is
  // race-safe and idempotent, so an ingredient resolved here but rolled back by
  // a failing tx below is harmless — a retry re-finds it.
  const driftNames = uniq(
    stale.filter((s) => s.nameDrift).map((s) => s.parsedName),
  );
  const idByName = new Map(
    await Promise.all(
      driftNames.map(
        async (name) =>
          [
            name.toLowerCase(),
            (await findOrCreateIngredient(db, name)).id,
          ] as const,
      ),
    ),
  );

  const writes: ReparsedStaleLineWrite[] = stale.map((row) => {
    const values: ReparsedStaleLineWrite["values"] = {};
    if (row.amountDrift) values.amounts = row.parsedAmounts;
    if (row.modifierDrift) values.modifier = row.parsedModifier;
    if (row.nameDrift) {
      const id = idByName.get(row.parsedName.toLowerCase());
      if (id) values.ingredientId = id;
    }
    return { recipeSectionIngredientId: row.recipeSectionIngredientId, values };
  });

  await applyReparsedStaleLines(db, writes);

  const recipesAffected = uniq(stale.map((s) => s.recipeEntityId));
  yield { done: stale.length, total: stale.length };
  return { updated: stale.length, recipesAffected };
}

// Delete unused ingredients (per-card or bulk). When `alsoDeleteProducts`, each
// ingredient's non-deleted products are deleted FIRST so deleteIngredients'
// linked-product guard passes. Processed per ingredient so one failure (a
// product with inventory → PRODUCT_HAS_INVENTORY, with a ledger row →
// PRODUCT_HAS_EXPENSES, or used as a task subject → PRODUCT_HAS_TASKS) is
// reported, not fatal to the batch.
export const deleteUnusedIngredients = async (
  db: Database,
  ingredientIds: IngredientId[],
  alsoDeleteProducts: boolean,
  actor: ActorContext,
): Promise<{
  deleted: number;
  failed: { id: IngredientId; reason: string }[];
}> => {
  let deleted = 0;
  const failed: { id: IngredientId; reason: string }[] = [];
  for (const id of ingredientIds) {
    try {
      if (alsoDeleteProducts) {
        const linked = await findLinkedProductIds(db, id);
        if (linked.length > 0) {
          const { detachedImageKeys } = await deleteProducts(db, linked, actor);
          // After the commit, never inside it: an R2 delete has no rollback.
          await deleteStoredObjects(detachedImageKeys);
        }
      }
      await deleteIngredients(db, [id], actor);
      deleted += 1;
    } catch (error) {
      failed.push({ id, reason: getErrorMessage(error) });
    }
  }
  return { deleted, failed };
};

// Cheap always-on counts for the Settings → Maintenance "N affected" labels —
// only DB detectors (no WASM sweep, no USDA/UPC network). The two WASM parse
// sweeps (stale parses, unused aliases) are deliberately NOT counted here: they
// re-parse every recipe line, so their numbers come from an on-demand dry run
// (dryRunReparse / dryRunPruneAliases) rather than this eager query.
export const findMaintenanceCounts = async (
  db: Database,
): Promise<MaintenanceCounts> => {
  const r = await traceAll({
    productsWithNoImages: () =>
      findProductsWithNoImages(db, { excludeIngredients: true }),
    locationsWithoutAiDescription: () =>
      countViewProblem(db, "locationsWithoutAiDescription"),
    staleRecipeTotals: () => countStaleRecipeTotals(db),
    cullablePendingImages: () =>
      countCullablePendingImages(db, CULL_PENDING_IMAGES_DEFAULT_HOURS),
    unreferencedImages: () => countUnreferencedImages(db),
    entitiesMissingEmbeddings: () => countMissingEmbeddings(db),
  });

  return {
    // Deliberately a SUBSET of the Problems-page productsWithNoImages count:
    // backfillUPCImages can only act on products that have a UPC to look up, so
    // this counts just those. Same canonical key, intentionally narrower number.
    productsWithNoImages: r.productsWithNoImages.filter((p) => p.upc != null)
      .length,
    locationsWithoutAiDescription: r.locationsWithoutAiDescription,
    staleRecipeTotals: r.staleRecipeTotals,
    cullablePendingImages: r.cullablePendingImages,
    unreferencedImages: r.unreferencedImages,
    // Uncapped, unlike the Problems section's sampled item rows — this is what
    // the auto-fix button counts.
    entitiesMissingEmbeddings: r.entitiesMissingEmbeddings,
  };
};

// Settings → Maintenance: the two WASM parse-sweep detectors, re-homed off the
// Problems hot path as manual dry-run + fix-all actions (they re-parse every
// recipe line — ~30s CPU and heap pressure that blew the request budget).

// Dry run for "Re-parse recipe lines": how many live imported lines would change
// (the expensive WASM sweep) out of all re-parseable lines (a cheap count).
export const dryRunReparse = async (
  db: Database,
): Promise<{ wouldChange: number; total: number }> => {
  const [stale, total] = await Promise.all([
    findStaleIngredientParses(db),
    countReparseableLines(db),
  ]);
  return { wouldChange: stale.length, total };
};

// Dry run for "Prune unused aliases": how many aliases would be stripped, across
// how many ingredients.
export const dryRunPruneAliases = async (
  db: Database,
): Promise<{ wouldPrune: number; ingredients: number }> => {
  const rows = await findIngredientsWithUnusedAliases(db);
  return {
    wouldPrune: sum(rows.map((r) => r.unusedAliases.length)),
    ingredients: rows.length,
  };
};

// Fix-all for unused aliases: detect every ingredient's unused aliases and strip
// them in one pass. Streams coarse progress like reparseStaleIngredientParses
// (the WASM sweep is the slow part; the prune itself is a single transaction).
export async function* pruneAllUnusedAliases(
  db: Database,
): AsyncGenerator<{ done: number; total: number }, { pruned: number }> {
  const rows = await findIngredientsWithUnusedAliases(db);
  if (rows.length === 0) {
    yield { done: 0, total: 0 };
    return { pruned: 0 };
  }
  yield { done: 0, total: rows.length };
  const resolved = await resolveLiveShortcodes(
    db,
    rows.map((row) => row.id),
    "ingredient",
  );
  const { pruned } = await pruneUnusedAliases(
    db,
    rows.flatMap((row) => {
      const entityId = resolved.get(row.id);
      return entityId
        ? [
            {
              ingredientId: unsafeIngredientId(entityId),
              remove: row.unusedAliases,
            },
          ]
        : [];
    }),
  );
  yield { done: rows.length, total: rows.length };
  return { pruned };
}

// Cost-grouped detector bundles. The Problems page loads these as separate tRPC
// queries routed through an UNBATCHED link, so each runs in its own Worker
// invocation / CPU budget — no single invocation sums all the detector CPU (the
// failure mode that exceeded the 30s limit). `findAllProblems` recomposes them
// for the badge/homepage/MCP consumers that still want one combined payload.

type ExactProblemPage = Awaited<ReturnType<typeof executeProblem>>;

/**
 * Lane orchestration never chooses a detector directly for derived Problems.
 * The typed diagnostic adapter is the sole dispatch point; this cast only
 * restores the existing card-presenter row type after that boundary.
 */
const diagnosticItems = async <T extends readonly unknown[]>(
  db: Database,
  diagnostic: Parameters<typeof runDiagnostic>[1],
): Promise<Omit<DiagnosticSampleResult, "items"> & { items: T }> => {
  const result = await runDiagnostic(
    db,
    diagnostic,
    {},
    {
      kind: "sample",
      limit: 12,
    },
  );
  return { ...result, items: result.items as T };
};

/** Run exact entity Problems with a caller-selected request-local bound. */
const runExactProblemPages = async (
  db: Database,
  keys: readonly ProblemKey[],
  options?: {
    projectionFreshness?: ProductConversionCoverageFreshness;
    concurrency?: number;
  },
): Promise<Partial<Record<ProblemKey, ExactProblemPage>>> => {
  const tasks = Object.fromEntries(
    keys.map((key) => [
      key,
      () =>
        executeProblem(db, key, {
          projectionFreshness: options?.projectionFreshness,
        }),
    ]),
  ) as Record<string, () => Promise<ExactProblemPage>>;
  return traceAllBounded(tasks, options?.concurrency ?? 4) as Promise<
    Partial<Record<ProblemKey, ExactProblemPage>>
  >;
};

const exactSectionTotals = (
  pages: Partial<Record<ProblemKey, ExactProblemPage>>,
): Record<string, number> =>
  Object.fromEntries(
    Object.entries(pages).map(([key, page]) => [key, page.count]),
  );

/**
 * Presentation only for the two conversion cards. Membership/count/order came
 * from `runExactProblemPages` first; this bounded hydration may enrich at most
 * two card pages and must never remove or reorder a selected row.
 */
const presentCoverageExactRows = async (
  db: Database,
  usdaClient: USDAClient,
  partialPage: ExactProblemPage,
  islandPage: ExactProblemPage,
): Promise<{
  ingredientsWithPartialCoverage: IngredientWithPartialCoverage[];
  productsWithIslandedMappings: ProductWithIslandedMappings[];
}> => {
  const selectedCodes = uniq([
    ...partialPage.data.map((row) => row.id),
    ...islandPage.data.map((row) => row.id),
  ]);
  const idsByCode = await resolveLiveShortcodes(db, selectedCodes, "product");
  const ids = [...idsByCode.values()] as ProductId[];
  const [products, projection] = await Promise.all([
    loadProductsForCoverage(db, ids),
    loadProductConversionCoverageProjection(db, ids),
  ]);
  // The projection already owns membership. A transient presenter-only USDA
  // failure must not turn that durable result into an empty/erroring section.
  const enriched = await batchEnrichWithFood(
    products,
    foodLookupParamFromProduct,
    usdaClient,
  ).catch(() => products.map((product) => ({ ...product, food: null })));
  const byCode = new Map(enriched.map((row) => [row.shortcode, row]));

  const partial = partialPage.data.map((row) => {
    const product = byCode.get(row.id);
    const productId = idsByCode.get(row.id) as ProductId | undefined;
    const coverage = productId ? projection.get(productId) : undefined;
    if (!product || !coverage || product.ingredient?.shortcode == null) {
      throw new Error(
        `Canonical conversion coverage Problem selected ${row.id}, but bounded presentation hydration was incomplete`,
      );
    }
    return {
      id: unsafeProductShortcode(product.shortcode),
      name: product.name,
      manufacturer: product.manufacturer,
      coverage: {
        covered:
          coverage.coveredKinds as IngredientWithPartialCoverage["coverage"]["covered"],
        applicable:
          coverage.applicableKinds as IngredientWithPartialCoverage["coverage"]["applicable"],
      },
      hasPrice: product.price != null,
      hasUsdaLink: product.food != null,
      usdaUnavailable: product.usdaUnavailable ?? false,
      ingredientId: unsafeIngredientShortcode(product.ingredient.shortcode),
    };
  });
  const islands = islandPage.data.map((row) => {
    const product = byCode.get(row.id);
    const productId = idsByCode.get(row.id) as ProductId | undefined;
    const coverage = productId ? projection.get(productId) : undefined;
    if (!product || !coverage) {
      throw new Error(
        `Canonical mapping-island Problem selected ${row.id}, but bounded presentation hydration was incomplete`,
      );
    }
    const effective = synthesizeEffectiveMappings({
      ...product,
      id: unsafeProductShortcode(product.shortcode),
    });
    // A transient presentation-time USDA miss must not change the already
    // selected projection membership. Fall back to stored maps for the card's
    // examples; the persisted island count remains authoritative.
    const islandUnits = wasm.detect_unit_mapping_islands(
      effective ?? product.unitMappings,
    );
    return {
      id: unsafeProductShortcode(product.shortcode),
      name: product.name,
      manufacturer: product.manufacturer,
      islandCount: coverage.islandCount,
      islands: islandUnits.map((units) => ({
        units: units.slice(0, 3),
        exampleUnit: units[0] ?? "unknown",
      })),
      coverage: {
        covered:
          coverage.coveredKinds as ProductWithIslandedMappings["coverage"]["covered"],
        applicable:
          coverage.applicableKinds as ProductWithIslandedMappings["coverage"]["applicable"],
      },
    };
  });
  return {
    ingredientsWithPartialCoverage: partial,
    productsWithIslandedMappings: islands,
  };
};

/**
 * Card-only projections for exact fast Problems.
 *
 * The entity list has already chosen these rows.  This function is deliberately
 * just a field projection: no predicate, grouping, or ordering may enter here.
 * Keeping it next to the lane makes that boundary reviewable and prevents a
 * rich card from accidentally becoming a second detector.
 */
const presentFastExactRows = <T>(
  key: string,
  page: ExactProblemPage,
  hydration?: {
    vendorExpenseCounts?: Map<string, { expenseRowCount: number }>;
    soldTotals?: Map<
      string,
      {
        soldQuantity: number;
        proceeds: number;
        servingLocations: { id: string; name: string }[];
      }
    >;
    allocationDefects?: Map<
      string,
      ProblemsFast["financialTransactionAllocationDefects"][number]
    >;
  },
): T[] =>
  page.data.map((row) => {
    const r = row as Record<string, unknown>;
    const id = String(r.id);
    const inventory = (r.inventoryEntry ?? []) as Array<{
      amount?: { value?: number };
      location?: { id?: string; name?: string };
    }>;
    const locations = inventory.flatMap((entry) =>
      entry.location?.id && entry.location.name
        ? [{ id: entry.location.id, name: entry.location.name }]
        : [],
    );
    switch (key) {
      case "duplicateInventory":
        return {
          id,
          name: String(r.name),
          manufacturer: String(r.manufacturer ?? ""),
          expectedQuantity: (r.expectedQuantity ?? null) as number | null,
          locations,
        };
      case "soldButStillStocked": {
        const totals = hydration?.soldTotals?.get(id);
        if (!totals)
          throw new Error(
            `Canonical sold-but-stocked Problem selected ${id}, but bounded presentation hydration found no row`,
          );
        return {
          id,
          name: String(r.name),
          manufacturer: String(r.manufacturer ?? ""),
          soldQuantity: totals.soldQuantity,
          liveQuantity: Number(r.onHandUnits ?? 0),
          proceeds: totals.proceeds,
          locations: uniqBy(
            [...locations, ...totals.servingLocations],
            (location) => location.id,
          ),
        };
      }
      case "unlinkedExitExpenses":
        return {
          id,
          name: String(r.name),
          cost: Number(r.cost),
          date: (r.date ?? null) as string | null,
          purchaseId: String(r.purchaseId),
          vendorName: (r.vendor ?? null) as string | null,
        };
      case "purchaselessExitExpenses":
        return {
          id,
          name: String(r.name),
          cost: Number(r.cost),
          date: (r.date ?? null) as string | null,
          projectName: (r.projectName ?? null) as string | null,
        };
      case "productsWithNoImages":
        return {
          id,
          name: String(r.name),
          manufacturer: String(r.manufacturer ?? ""),
          upc: (r.upc ?? null) as string | null,
        };
      case "unreferencedImages":
        return {
          id,
          key: String(r.key),
          filename: String(r.filename),
          contentType: String(r.contentType),
          size: Number(r.size),
          createdAt: r.createdAt as Date,
          targetType: (r.entityType ?? null) as string | null,
          targetId: (r.entityId ?? null) as string | null,
        };
      case "understatedCostMeals": {
        const recipes = (r.recipes ?? []) as Array<{
          recipe?: {
            totals?: { costCovered?: number; ingredientCount?: number } | null;
          };
        }>;
        return {
          id,
          name: (r.name ?? null) as string | null,
          date: r.date as string,
          recipeCount: recipes.filter(
            (entry) =>
              (entry.recipe?.totals?.costCovered ?? 0) <
              (entry.recipe?.totals?.ingredientCount ?? 0),
          ).length,
        };
      }
      case "unknownParkedItems":
        return {
          id,
          amount: r.amount,
          createdAt: r.createdAt,
          product: r.product,
          location: r.location,
        };
      case "inventoryWithoutPricePath":
        return {
          id,
          amount: r.amount,
          effectivePrice: Number(
            (r.product as { effectivePrice?: number } | undefined)
              ?.effectivePrice ?? 0,
          ),
          product: r.product,
          location: r.location,
        };
      case "vendorsWithoutLogos": {
        const counts = hydration?.vendorExpenseCounts?.get(id);
        if (!counts)
          throw new Error(
            `Canonical vendor-logo Problem selected ${id}, but bounded presentation hydration found no row`,
          );
        return {
          id,
          name: String(r.name),
          website: (r.website ?? null) as string | null,
          purchaseCount: Number(r.purchaseCount ?? 0),
          expenseRowCount: counts.expenseRowCount,
        };
      }
      case "purchasesNotReconciling":
        return {
          id,
          vendorName: (r.vendorName ?? null) as string | null,
          orderId: (r.orderId ?? null) as string | null,
          orderUrl: (r.orderUrl ?? null) as string | null,
          date: (r.date ?? null) as string | null,
          statedTotal: Number(r.statedTotal),
          expenseTotal: Number(r.expenseTotal),
          expenseCount: Number(r.expenseCount),
          unpricedExpenseCount: Number(r.unpricedExpenseCount),
          postedRefundTotal: Number(
            (r.reconciliation as { postedRefundTotal?: number } | undefined)
              ?.postedRefundTotal ?? 0,
          ),
        };
      case "purchaseFinancialSettlementMismatches":
        return {
          id,
          vendorName: (r.vendorName ?? null) as string | null,
          expenseTotal: Number(r.expenseTotal),
          financialReconciliation: r.financialReconciliation,
        };
      case "financialTransactionAllocationDefects": {
        const hydrated = hydration?.allocationDefects?.get(id);
        if (hydrated) return hydrated;
        throw new Error(
          `Canonical allocation Problem selected ${id}, but bounded presentation hydration found no row`,
        );
      }
      default:
        throw new Error(
          `No exact card presenter declared for Problem "${key}"`,
        );
    }
  }) as T[];

const presentSingleFastProblem = async (
  db: Database,
  key: (typeof FAST_ENTITY_PROBLEM_KEYS)[number],
  page: ExactProblemPage,
): Promise<unknown[]> => {
  if (key === "vendorsWithoutLogos") {
    return presentFastExactRows(key, page, {
      vendorExpenseCounts: await loadVendorLogoPresenterCounts(
        db,
        page.data.map((row) => row.id),
      ),
    });
  }
  if (key === "soldButStillStocked") {
    return presentFastExactRows(key, page, {
      soldTotals: await loadSoldButStockedPresenterTotals(
        db,
        page.data.map((row) => row.id),
      ),
    });
  }
  if (key === "financialTransactionAllocationDefects") {
    return presentFastExactRows(key, page, {
      allocationDefects: await loadAllocationDefectPresenters(
        db,
        page.data.map((row) => row.id),
      ),
    });
  }
  return presentFastExactRows(key, page);
};

const FAST_ENTITY_PROBLEM_KEYS = [
  "duplicateInventory",
  "soldButStillStocked",
  "unlinkedExitExpenses",
  "purchaselessExitExpenses",
  "productsWithNoImages",
  "unreferencedImages",
  "understatedCostMeals",
  "unknownParkedItems",
  "inventoryWithoutPricePath",
  "vendorsWithoutLogos",
  "purchasesNotReconciling",
  "purchaseFinancialSettlementMismatches",
  "financialTransactionAllocationDefects",
] as const satisfies readonly ProblemKey[];

// DB-only detectors — cheap (no WASM, no network). Bounded tracing keeps a
// named span per detector for observability while overlapping remote I/O.
export const findFastProblems = async (db: Database): Promise<ProblemsFast> => {
  const exactKeys = FAST_ENTITY_PROBLEM_KEYS;

  // Production traces show remote query waits in the 30–180ms range while a
  // checkout costs ~20ms. Run the derived and entity-backed branches together,
  // bounded to four tasks so the request-local max:5 pool retains one slot for
  // a list task's own count/hydration query.
  const [r, exact] = await Promise.all([
    traceAllBounded(
      {
        // One extra SELECT over Product + one over ProductExternalId, grouped in
        // JS — same shape and cost class as the spelling-variant scans below.
        duplicateProductIdentities: () =>
          diagnosticItems<ProblemsFast["duplicateProductIdentities"]>(
            db,
            "duplicate-product-identities",
          ),
        orphanedProducts: () =>
          diagnosticItems<ProblemsFast["orphanedProducts"]>(
            db,
            "orphaned-products",
          ),
        partiallyImportedCookbooks: () =>
          diagnosticItems<ProblemsFast["partiallyImportedCookbooks"]>(
            db,
            "partially-imported-cookbooks",
          ),
        // One grouped scan of the product-linked Expense rows, filtered down to
        // the offenders by a HAVING rather than in JS.
        // One scan of the ~90 usage edges plus the whole-tree date fold. Cheap
        // enough for this group; the fold is the same two queries
        // `projectToolMatrix` already runs per page load.
        toolsUsedOutsideOwnership: () =>
          diagnosticItems<ProblemsFast["toolsUsedOutsideOwnership"]>(
            db,
            "tools-used-outside-ownership",
          ),
        orphanedEntityEmbeddings: () =>
          diagnosticItems<ProblemsFast["orphanedEntityEmbeddings"]>(
            db,
            "orphaned-entity-embeddings",
          ),
        // One UNION across searchable entity tables, with its exact count
        // carried by a window — one round trip rather than one per type.
        entitiesMissingEmbeddings: () =>
          diagnosticItems<ProblemsFast["entitiesMissingEmbeddings"]>(
            db,
            "entities-missing-embeddings",
          ),
        staleParentRecipes: () =>
          diagnosticItems<ProblemsFast["staleParentRecipes"]>(
            db,
            "stale-parent-recipes",
          ),
        manufacturerSpellingVariants: () =>
          diagnosticItems<ProblemsFast["manufacturerSpellingVariants"]>(
            db,
            "manufacturer-spelling-variants",
          ),
        // Same shared spelling-key SQL as above, over the vendor roster instead —
        // one grouped scan of 114 rows.
        duplicateVendors: () =>
          diagnosticItems<ProblemsFast["duplicateVendors"]>(
            db,
            "duplicate-vendors",
          ),
        // Amount+date joins ~80 unlinked expenses against ~1.6k purchases, then
        // scores trigram similarity on only the handful that survive — measured at
        // ~31ms, all buffer hits. Cheap because the name comparison is post-join.
        duplicateSpendCandidates: () =>
          diagnosticItems<ProblemsFast["duplicateSpendCandidates"]>(
            db,
            "duplicate-spend-candidates",
          ),
        duplicateFinancialTransactionSourceRefs: () =>
          diagnosticItems<
            ProblemsFast["duplicateFinancialTransactionSourceRefs"]
          >(db, "duplicate-financial-transaction-source-refs"),
        duplicateFinancialAccountSourceAliases: () =>
          diagnosticItems<
            ProblemsFast["duplicateFinancialAccountSourceAliases"]
          >(db, "duplicate-financial-account-source-aliases"),
        invalidFinancialJson: () =>
          diagnosticItems<ProblemsFast["invalidFinancialJson"]>(
            db,
            "invalid-financial-json",
          ),
        // One grouped scan of the (small) import roster with a LEFT JOIN count.
        // The ONLY statement-ledger detector: unmatched rows are the drift
        // worklist, not defects, and 15k of them would make Problems unusable.
        incompleteStatementImports: () =>
          diagnosticItems<ProblemsFast["incompleteStatementImports"]>(
            db,
            "incomplete-statement-imports",
          ),
        referentialLivenessViolations: () =>
          diagnosticItems<ProblemsFast["referentialLivenessViolations"]>(
            db,
            "referential-liveness-violations",
          ),
      },
      2,
    ),
    runExactProblemPages(db, exactKeys, { concurrency: 2 }),
  ]);
  const legacy = {
    duplicateProductIdentities: r.duplicateProductIdentities.items,
    orphanedProducts: r.orphanedProducts.items,
    partiallyImportedCookbooks: r.partiallyImportedCookbooks.items,
    toolsUsedOutsideOwnership: r.toolsUsedOutsideOwnership.items,
    orphanedEntityEmbeddings: r.orphanedEntityEmbeddings.items,
    entitiesMissingEmbeddings: r.entitiesMissingEmbeddings.items,
    staleParentRecipes: r.staleParentRecipes.items,
    manufacturerSpellingVariants: r.manufacturerSpellingVariants.items,
    duplicateVendors: r.duplicateVendors.items,
    duplicateSpendCandidates: r.duplicateSpendCandidates.items,
    duplicateFinancialTransactionSourceRefs:
      r.duplicateFinancialTransactionSourceRefs.items,
    duplicateFinancialAccountSourceAliases:
      r.duplicateFinancialAccountSourceAliases.items,
    invalidFinancialJson: r.invalidFinancialJson.items,
    incompleteStatementImports: r.incompleteStatementImports.items,
    referentialLivenessViolations: r.referentialLivenessViolations.items,
  } satisfies Partial<Omit<ProblemsFast, "sectionTotals">>;

  const derivedTotals = Object.fromEntries(
    Object.entries(r).map(([key, result]) => [key, result.count]),
  );

  const page = (key: (typeof exactKeys)[number]): ExactProblemPage => {
    const result = exact[key];
    if (!result) throw new Error(`Missing canonical Problem result "${key}"`);
    return result;
  };
  const [vendorExpenseCounts, allocationDefects, soldTotals] =
    await Promise.all([
      loadVendorLogoPresenterCounts(
        db,
        page("vendorsWithoutLogos").data.map((row) => row.id),
      ),
      loadAllocationDefectPresenters(
        db,
        page("financialTransactionAllocationDefects").data.map((row) => row.id),
      ),
      loadSoldButStockedPresenterTotals(
        db,
        page("soldButStillStocked").data.map((row) => row.id),
      ),
    ]);
  const hydration = { vendorExpenseCounts, allocationDefects, soldTotals };

  return {
    ...legacy,
    duplicateInventory: presentFastExactRows(
      "duplicateInventory",
      page("duplicateInventory"),
    ),
    soldButStillStocked: presentFastExactRows(
      "soldButStillStocked",
      page("soldButStillStocked"),
      hydration,
    ),
    unlinkedExitExpenses: presentFastExactRows(
      "unlinkedExitExpenses",
      page("unlinkedExitExpenses"),
    ),
    purchaselessExitExpenses: presentFastExactRows(
      "purchaselessExitExpenses",
      page("purchaselessExitExpenses"),
    ),
    productsWithNoImages: presentFastExactRows(
      "productsWithNoImages",
      page("productsWithNoImages"),
    ),
    unreferencedImages: presentFastExactRows(
      "unreferencedImages",
      page("unreferencedImages"),
    ),
    understatedCostMeals: presentFastExactRows(
      "understatedCostMeals",
      page("understatedCostMeals"),
    ),
    unknownParkedItems: presentFastExactRows(
      "unknownParkedItems",
      page("unknownParkedItems"),
    ),
    inventoryWithoutPricePath: presentFastExactRows(
      "inventoryWithoutPricePath",
      page("inventoryWithoutPricePath"),
    ),
    vendorsWithoutLogos: presentFastExactRows(
      "vendorsWithoutLogos",
      page("vendorsWithoutLogos"),
      hydration,
    ),
    purchasesNotReconciling: presentFastExactRows(
      "purchasesNotReconciling",
      page("purchasesNotReconciling"),
    ),
    purchaseFinancialSettlementMismatches: presentFastExactRows(
      "purchaseFinancialSettlementMismatches",
      page("purchaseFinancialSettlementMismatches"),
    ),
    financialTransactionAllocationDefects: presentFastExactRows(
      "financialTransactionAllocationDefects",
      page("financialTransactionAllocationDefects"),
      hydration,
    ),
    sectionTotals: { ...derivedTotals, ...exactSectionTotals(exact) },
  };
};

export const cleanupOrphanedEntityEmbeddings = async (
  db: Database,
  ids?: string[],
): Promise<{ found: number; deleted: number }> => {
  const orphaned = await findOrphanedEntityEmbeddings(db);
  const targets = ids?.length
    ? orphaned.filter((row) => ids.includes(row.id))
    : orphaned;
  const deleted = await softDeleteEntityEmbeddingRows(
    db,
    targets.map((row) => row.id),
  );
  return { found: orphaned.length, deleted };
};

// Population denominators for the coverage meters. Cheap count(*)s, pinned to
// ONE connection like findFastProblems (the cost here is connection
// acquisition, not the queries). Deliberately NOT on the unbatched hot path —
// it's page-only, and neither the navbar badge nor MCP needs it.
export const findCoverageTotals = (db: Database): Promise<CoverageTotals> =>
  withConnection(db, (scoped) => findCoverageTotalsRepo(scoped));

/**
 * Conversion coverage's hot path is projection-first. Rebuilding remains the
 * explicit `rebuildProductConversionCoverageProjection` maintenance seam;
 * stale/missing rows stay absent from exact filters and are reported on the
 * wire instead of being synchronously recomputed during page rendering.
 */
export const findCoverageProblems = async (
  db: Database,
  usdaClient: USDAClient,
): Promise<ProblemsCoverage> => {
  let freshness = await getProductConversionCoverageFreshness(db);
  // Normal mutations synchronously mark affected rows stale. This isolated
  // lane is their durable convergence point: healthy page loads are pure
  // read-model queries, while a stale/missing projection is rebuilt once here
  // through the shared engine and then re-read. Provider failures persist as
  // `unavailable`, which stays fail-closed rather than becoming a healthy 0.
  if (
    freshness.staleCount > 0 ||
    freshness.missingCount > 0 ||
    freshness.unavailableCount > 0
  ) {
    try {
      await rebuildProductConversionCoverageProjection(db, usdaClient);
      freshness = await getProductConversionCoverageFreshness(db);
    } catch (error) {
      // The durable relation is still the authority. A USDA outage must not
      // turn into a failed Problems page (or, worse, an empty healthy card):
      // leave the prior stale/unavailable rows intact, let the exact filters
      // fail closed, and return their existing freshness state to the UI.
      console.warn(
        `[findCoverageProblems] conversion projection rebuild failed; serving ${freshness.state} persisted projection: ${getErrorMessage(error)}`,
      );
    }
  }
  const exact = await runExactProblemPages(
    db,
    ["ingredientsWithPartialCoverage", "productsWithIslandedMappings"],
    { projectionFreshness: freshness },
  );
  const ingredientsPage = exact.ingredientsWithPartialCoverage;
  const islandsPage = exact.productsWithIslandedMappings;
  if (!ingredientsPage || !islandsPage) {
    throw new Error("Missing canonical conversion coverage Problem result");
  }
  const presented = await presentCoverageExactRows(
    db,
    usdaClient,
    ingredientsPage,
    islandsPage,
  );
  // Runs through the diagnostic registry rather than inline, so the roster in
  // `problem-registry` can describe it (a `derived` source names a
  // DiagnosticKey). Independent of the USDA-enriched pair above: no network, no
  // enrichment — just the Rust grammar over titles the DB already narrowed. It
  // shares this lane rather than `fast` because that lane's contract is
  // explicitly DB-only with no WASM.
  const titleSized = await diagnosticItems<ProductWithTitleDerivableSize[]>(
    db,
    "title-derivable-unit-size",
  );
  return {
    ...presented,
    // `items` is a sample; `count` is the real population, and the section
    // total must be the latter or the card under-reports a ~1,400-row backlog.
    productsWithTitleDerivableSize: titleSized.items,
    sectionTotals: {
      ...exactSectionTotals(exact),
      productsWithTitleDerivableSize: titleSized.count,
    },
    freshness,
  };
};

// UPC-lookup network detector.
const findProductsWithBetterUpcData = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
): Promise<{
  products: ProductWithBetterUpcData[];
  count: number;
  freshness: NonNullable<
    Awaited<ReturnType<typeof runDiagnostic>>["freshness"]
  >;
}> => {
  const result = await runDiagnostic(db, "products-with-better-upc-data", {
    upcLookupClient,
  });
  if (!result.freshness) {
    throw new Error("UPC diagnostic adapter omitted its freshness contract");
  }
  return {
    products: result.items as ProductWithBetterUpcData[],
    count: result.count,
    freshness: result.freshness,
  };
};

// Household-tracker group — the seven attention rules the /projects overview
// already computes (overdue tasks, stalled projects, missing budgets, past-due
// planned expenses, unclassified expenses, blocked work, date-window
// drift), promoted to first-class Problems so the navbar badge / homepage
// banner / MCP see them.
// The detection itself stays in the repo (computeAttentionItems); this only
// splits the flat item list into the per-rule slices.
const TRACKER_PROBLEM_KEYS = [
  "overdueTasks",
  "stalledProjects",
  "projectsMissingBudget",
  "pastDuePlannedExpenses",
  "unclassifiedExpenses",
  "blockedWorkProjects",
  "projectsWithDateDrift",
] as const satisfies readonly ProblemKey[];

type TrackerEntityProblemKey = Exclude<
  (typeof TRACKER_PROBLEM_KEYS)[number],
  "projectsWithDateDrift"
>;

const presentTrackerProblem = (
  key: TrackerEntityProblemKey,
  page: ExactProblemPage,
): ProjectAttentionItem[] =>
  page.data.map((row) => {
    const r = row as Record<string, unknown>;
    const id = String(r.id);
    const name = String(r.name ?? "Untitled");
    const isTask = key === "overdueTasks";
    const isExpense =
      key === "pastDuePlannedExpenses" || key === "unclassifiedExpenses";
    const type =
      key === "overdueTasks"
        ? "overdue_task"
        : key === "stalledProjects"
          ? "stalled_project"
          : key === "projectsMissingBudget"
            ? "missing_budget"
            : key === "pastDuePlannedExpenses"
              ? "past_due_planned_expense"
              : key === "unclassifiedExpenses"
                ? "unclassified_expense"
                : "blocked_work";
    const entityType = isTask ? "task" : isExpense ? "expense" : "project";
    const date = isTask
      ? ((r.dueEndDate ?? r.dueDate ?? null) as string | null)
      : isExpense
        ? ((r.date ?? null) as string | null)
        : key === "stalledProjects"
          ? r.updatedAt instanceof Date
            ? r.updatedAt.toISOString().slice(0, 10)
            : null
          : null;
    const amount =
      key === "projectsMissingBudget"
        ? Number(
            (
              r.rollup as
                | {
                    subtree?: {
                      actualSpent?: number;
                      committedSpent?: number;
                    };
                  }
                | undefined
            )?.subtree?.actualSpent ?? 0,
          ) +
          Number(
            (r.rollup as { subtree?: { committedSpent?: number } } | undefined)
              ?.subtree?.committedSpent ?? 0,
          )
        : null;
    return {
      key: `${type}:${id}`,
      type,
      severity:
        key === "overdueTasks"
          ? "critical"
          : key === "stalledProjects" || key === "pastDuePlannedExpenses"
            ? "warning"
            : "info",
      description:
        key === "overdueTasks"
          ? `"${name}" is overdue and still open`
          : key === "stalledProjects"
            ? `"${name}" has had no recent project activity`
            : key === "projectsMissingBudget"
              ? `"${name}" has spend but no budget estimate`
              : key === "pastDuePlannedExpenses"
                ? `"${name}" is a past-due planned expense`
                : key === "unclassifiedExpenses"
                  ? `"${name}" has no trade or cost recorded`
                  : `"${name}" has blocked work and no next action`,
      entityType,
      entityId: id,
      date,
      amount,
      href: `/${entityType === "task" ? "tasks" : entityType === "expense" ? "expenses" : "projects"}/${id}`,
    };
  });

export const findTrackerProblems = async (
  db: Database,
): Promise<ProblemsTracker> => {
  const exactKeys = TRACKER_PROBLEM_KEYS;
  const exact = await runExactProblemPages(db, exactKeys);
  const page = (key: (typeof exactKeys)[number]): ExactProblemPage => {
    const result = exact[key];
    if (!result) throw new Error(`Missing canonical Problem result "${key}"`);
    return result;
  };
  return {
    overdueTasks: presentTrackerProblem("overdueTasks", page("overdueTasks")),
    stalledProjects: presentTrackerProblem(
      "stalledProjects",
      page("stalledProjects"),
    ),
    projectsMissingBudget: presentTrackerProblem(
      "projectsMissingBudget",
      page("projectsMissingBudget"),
    ),
    pastDuePlannedExpenses: presentTrackerProblem(
      "pastDuePlannedExpenses",
      page("pastDuePlannedExpenses"),
    ),
    unclassifiedExpenses: presentTrackerProblem(
      "unclassifiedExpenses",
      page("unclassifiedExpenses"),
    ),
    blockedWorkProjects: presentTrackerProblem(
      "blockedWorkProjects",
      page("blockedWorkProjects"),
    ),
    // This remains derived because one project may produce two date-window
    // rows.  Its typed adapter computes the complete relation before sampling.
    projectsWithDateDrift: page("projectsWithDateDrift")
      .items as ProjectAttentionItem[],
    sectionTotals: {
      ...exactSectionTotals(exact),
    },
  };
};

export const findUpcProblems = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
): Promise<ProblemsUpc> => {
  const {
    products: productsWithBetterUpcData,
    count,
    freshness,
  } = await findProductsWithBetterUpcData(db, upcLookupClient);
  return {
    productsWithBetterUpcData,
    // Proposal membership is materialized by UPC and can be counted exactly.
    sectionTotals: {
      productsWithBetterUpcData: count,
    },
    freshness,
  };
};

/**
 * Count every registered Problem through the same executor that supplies its
 * sample. Entity-backed Problems select the explicit count intent, so list
 * predicates and exact totals stay canonical without constructing card SQL;
 * derived Problems use their dedicated count adapters.
 */
export const findProblemCounts = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
): Promise<ProblemsCount> => {
  const declarations = problemQueryDeclarations();
  const tasks = Object.fromEntries(
    declarations.map((definition) => [
      definition.key,
      async () =>
        (
          await executeProblem(db, definition.key, {
            mode: "count",
            diagnostic: { upcLookupClient },
          })
        ).count,
    ]),
  ) as Record<string, () => Promise<number>>;
  const counts = await traceAllBounded(tasks, 4);
  const byType = Object.fromEntries(
    declarations.map((definition) => [
      definition.key,
      Number(counts[definition.key] ?? 0),
    ]),
  ) as ProblemsCount["byType"];
  const totalFor = (problemClass: "defect" | "coverage") =>
    declarations.reduce(
      (total, definition) =>
        definition.problemClass === problemClass
          ? total + byType[definition.key]
          : total,
      0,
    );
  return {
    total: totalFor("defect"),
    coverageTotal: totalFor("coverage"),
    byType,
  };
};

/** Execute only one registry entry for focused MCP/problem consumers. */
export const findProblemByType = async (
  db: Database,
  key: ProblemKey,
  upcLookupClient: UPCLookupClient,
  usdaClient: USDAClient,
): Promise<{ type: ProblemKey; items: unknown[]; total: number }> => {
  const result = await executeProblem(db, key, {
    diagnostic: { upcLookupClient },
  });
  if ((FAST_ENTITY_PROBLEM_KEYS as readonly ProblemKey[]).includes(key)) {
    return {
      type: key,
      items: await presentSingleFastProblem(
        db,
        key as (typeof FAST_ENTITY_PROBLEM_KEYS)[number],
        result,
      ),
      total: result.count,
    };
  }
  if (
    key === "ingredientsWithPartialCoverage" ||
    key === "productsWithIslandedMappings"
  ) {
    const empty = { ...result, data: [], items: [] };
    const presented = await presentCoverageExactRows(
      db,
      usdaClient,
      key === "ingredientsWithPartialCoverage" ? result : empty,
      key === "productsWithIslandedMappings" ? result : empty,
    );
    return {
      type: key,
      items:
        key === "ingredientsWithPartialCoverage"
          ? presented.ingredientsWithPartialCoverage
          : presented.productsWithIslandedMappings,
      total: result.count,
    };
  }
  if (
    key !== "projectsWithDateDrift" &&
    (TRACKER_PROBLEM_KEYS as readonly ProblemKey[]).includes(key)
  ) {
    return {
      type: key,
      items: presentTrackerProblem(key as TrackerEntityProblemKey, result),
      total: result.count,
    };
  }
  return { type: key, items: [...result.items], total: result.count };
};

// Combined scan for the badge/homepage/MCP — recomposed from the same groups so
// there's one definition of each detector's membership. totalProblems is the
// sum of every section length — derived, never hand-summed.
export const findAllProblems = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
  usdaClient: USDAClient,
): Promise<AllProblems> => {
  const groups = await traceAll({
    fast: () => findFastProblems(db),
    coverage: () => findCoverageProblems(db, usdaClient),
    upc: () => findUpcProblems(db, upcLookupClient),
    tracker: () => findTrackerProblems(db),
    views: () => findViewProblems(db),
  });
  return assembleAllProblems(groups);
};
