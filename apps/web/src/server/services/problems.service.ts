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
  type ProblemsCoverage,
  type ProblemsFast,
  type ProblemsTracker,
  type ProblemsUpc,
  type ProductWithBetterUpcData,
  type ProductWithIslandedMappings,
  TRACKER_PROBLEM_KEY_BY_TYPE,
} from "@cubby/schemas/problems";
import { isMiscProduct, isNonFoodCategory } from "@cubby/shared";
import { sum, uniq, uniqBy } from "es-toolkit";
import { env } from "~/env";
import {
  BASE_KINDS,
  conversionCoverage,
  gradedKinds,
} from "~/lib/conversion-coverage";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { isMoneyUnit } from "~/lib/price-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import { type Database, withConnection } from "~/server/db";
import {
  findOrphanedEntityEmbeddings,
  softDeleteEntityEmbeddingRows,
} from "~/server/repo/entity-embedding";
import { countCullablePendingImages } from "~/server/repo/image";
import {
  deleteIngredients,
  findOrCreateIngredient,
} from "~/server/repo/ingredient";
import {
  applyReparsedStaleLines,
  countEntitiesMissingEmbeddings,
  countReparseableLines,
  findCoverageTotals as findCoverageTotalsRepo,
  findDuplicateFinancialAccountSourceAliases,
  findDuplicateFinancialTransactionSourceRefs,
  findDuplicateUniqueProducts,
  findDuplicateVendors,
  findEmptyLocations,
  findEntitiesMissingEmbeddings,
  findIngredientsWithoutProduct,
  findIngredientsWithUnusedAliases,
  findInvalidFinancialJson,
  findLinkedProductIds,
  findLocationsWithoutAiDescription,
  findManufacturerSpellingVariants,
  findNeverVerifiedInventory,
  findOrphanedProducts,
  findParentRecipesWithDeletedSubRecipes,
  findProductsMissingPrice,
  findProductsWithoutMappings,
  findProductsWithUpcGaps,
  findPurchaseFinancialSettlementMismatches,
  findPurchasesNotReconciling,
  findReferentialLivenessViolations,
  findStaleIngredientParses,
  findStaleLocations,
  findUnknownParkedItems,
  findUnusedIngredients,
  findVendorsWithoutLogos,
  loadProductsForCoverage,
  pruneUnusedAliases,
  type ReparsedStaleLineWrite,
  synthesizeEffectiveMappings,
} from "~/server/repo/problems";
import {
  deleteProducts,
  findProductsWithNoImages,
} from "~/server/repo/product";
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import { computeAttentionItems } from "~/server/repo/project";
import { countStaleRecipeTotals } from "~/server/repo/recipe/totals";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";
import { batchEnrichWithFood } from "~/server/services/usda-helpers";
import { traceAll, traceAllSeq } from "~/server/tracing";

// The embedding-coverage detector is gated HERE rather than in the repo, so the
// repo stays pure data access and the env read stays in the service layer.
//
// The gate itself is load-bearing: with no AI_GATEWAY_API_KEY every live row in
// all ten searchable tables reads as "missing an embedding", and nothing can
// ever clear it — `enqueueEntityEmbeddingBackfill` doesn't check configuration
// either, so it would cheerfully enqueue thousands of jobs that all throw at
// `embedTexts`. Report nothing rather than an unfixable wall. Mirrors the
// degradation the semantic read paths already do.
const findMissingEmbeddings = async (db: Database) =>
  semanticEmbeddingsConfigured()
    ? findEntitiesMissingEmbeddings(db, getSemanticEmbeddingConfig())
    : [];

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
//     findProductsWithoutMappings skips it) whose effective conversion graph
//     (stored conversions + price edge + USDA edges) still can't reach all four
//     base kinds. Money in a unit mapping counts like a scalar price.
//   - islanded mappings: a product whose *effective* mappings still split into
//     2+ components. A product islanded on its stored mappings alone but bridged
//     into one component by USDA portion/serving edges is fully convertible, so
//     it isn't flagged — mirroring the "a USDA link counts as coverage" rule in
//     findProductsWithoutMappings.
const findProductCoverageProblems = async (
  db: Database,
  usdaClient: USDAClient,
): Promise<{
  ingredientsWithPartialCoverage: IngredientWithPartialCoverage[];
  productsWithIslandedMappings: ProductWithIslandedMappings[];
}> => {
  // One scan, a superset of both detectors' needs: all non-deleted products with
  // their stored mappings + the linked ingredient's N/A opt-outs.
  const products = await loadProductsForCoverage(db);

  // Candidate sets are pure DB/WASM (no network). Partial coverage wants
  // ingredient products with *some* signal — truly-empty ones belong to
  // findProductsWithoutMappings. Islanded wants products whose STORED mappings
  // already split into 2+ components: adding the derived edges can only merge
  // components, never split them, so a product connected on its stored mappings
  // can never be islanded. detect_unit_mapping_islands is infallible (never throws).
  // Non-food (household/garage) products have no food-coverage meaning — exempt
  // them from both coverage detectors, matching findProductsWithoutMappings.
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
  for (const cand of partialCandidates) {
    const p = enrichedById.get(cand.id);
    const effective = p ? effectiveById.get(p.id) : null;
    if (!p || !effective) continue;

    // partialCandidates guarantees ingredientId != null; narrow for the
    // non-nullable schema fields (the joined ingredient carries the shortcode
    // these rows link by).
    if (p.ingredientId == null || p.ingredient == null) continue;

    const applicable = gradedKinds(p.ingredient?.naKinds);
    const cov = conversionCoverage(effective, applicable);
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
    if (!p || !effective) continue;

    const islands = wasm.detect_unit_mapping_islands(effective);
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

  return { ingredientsWithPartialCoverage, productsWithIslandedMappings };
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
          await deleteProducts(db, linked, actor);
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
    locationsWithoutAiDescription: () => findLocationsWithoutAiDescription(db),
    staleRecipeTotals: () => countStaleRecipeTotals(db),
    cullablePendingImages: () =>
      countCullablePendingImages(db, CULL_PENDING_IMAGES_DEFAULT_HOURS),
    entitiesMissingEmbeddings: () => countMissingEmbeddings(db),
  });

  return {
    // Deliberately a SUBSET of the Problems-page productsWithNoImages count:
    // backfillUPCImages can only act on products that have a UPC to look up, so
    // this counts just those. Same canonical key, intentionally narrower number.
    productsWithNoImages: r.productsWithNoImages.filter((p) => p.upc != null)
      .length,
    locationsWithoutAiDescription: r.locationsWithoutAiDescription.length,
    staleRecipeTotals: r.staleRecipeTotals,
    cullablePendingImages: r.cullablePendingImages,
    // Uncapped, unlike the Problems section's sampled item rows — this is what
    // the auto-fix button counts.
    entitiesMissingEmbeddings: r.entitiesMissingEmbeddings,
  };
};

// ---------------------------------------------------------------------------
// Settings → Maintenance: the two WASM parse-sweep detectors, re-homed off the
// Problems hot path as manual dry-run + fix-all actions (they re-parse every
// recipe line — ~30s CPU and heap pressure that blew the request budget).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cost-grouped detector bundles. The Problems page loads these as separate tRPC
// queries routed through an UNBATCHED link, so each runs in its own Worker
// invocation / CPU budget — no single invocation sums all the detector CPU (the
// failure mode that exceeded the 30s limit). `findAllProblems` recomposes them
// for the badge/homepage/MCP consumers that still want one combined payload.
// ---------------------------------------------------------------------------

// DB-only detectors — cheap (no WASM, no network). traceAll keeps a named span
// per detector for observability.
export const findFastProblems = async (db: Database): Promise<ProblemsFast> => {
  // All of these detectors are read-only single SELECTs (~0ms each); the cost is
  // connection acquisition. Pin them to ONE shared connection so the fan-out
  // pays a single `db.acquire` instead of 10 contending for the max:5 pool.
  // traceAllSeq runs them sequentially (each still its own span) — a pg client
  // takes one query at a time, and the per-query cost is ~0, so serializing on
  // one connection beats 8 cold connects. See withConnection in db.ts.
  const r = await withConnection(db, (scoped) =>
    traceAllSeq({
      duplicateUniqueProducts: () => findDuplicateUniqueProducts(scoped),
      orphanedProducts: () => findOrphanedProducts(scoped),
      productsMissingPrice: () => findProductsMissingPrice(scoped),
      productsWithoutMappings: () => findProductsWithoutMappings(scoped),
      ingredientsWithoutProduct: () => findIngredientsWithoutProduct(scoped),
      unusedIngredients: () => findUnusedIngredients(scoped),
      emptyLocations: () => findEmptyLocations(scoped),
      productsWithNoImages: () =>
        findProductsWithNoImages(scoped, { excludeIngredients: true }),
      locationsWithoutAiDescription: () =>
        findLocationsWithoutAiDescription(scoped),
      orphanedEntityEmbeddings: () => findOrphanedEntityEmbeddings(scoped),
      entitiesMissingEmbeddings: () => findMissingEmbeddings(scoped),
      staleParentRecipes: () => findParentRecipesWithDeletedSubRecipes(scoped),
      staleLocations: () => findStaleLocations(scoped),
      neverVerifiedInventory: () => findNeverVerifiedInventory(scoped),
      unknownParkedItems: () => findUnknownParkedItems(scoped),
      manufacturerSpellingVariants: () =>
        findManufacturerSpellingVariants(scoped),
      // Same shared spelling-key SQL as above, over the vendor roster instead —
      // one grouped scan of 114 rows.
      duplicateVendors: () => findDuplicateVendors(scoped),
      vendorsWithoutLogos: () => findVendorsWithoutLogos(scoped),
      // One grouped SQL scan that returns only the offenders (the stated-total
      // comparison is a HAVING, not a JS filter) — cheap enough for this group.
      purchasesNotReconciling: () => findPurchasesNotReconciling(scoped),
      purchaseFinancialSettlementMismatches: () =>
        findPurchaseFinancialSettlementMismatches(scoped),
      duplicateFinancialTransactionSourceRefs: () =>
        findDuplicateFinancialTransactionSourceRefs(scoped),
      duplicateFinancialAccountSourceAliases: () =>
        findDuplicateFinancialAccountSourceAliases(scoped),
      invalidFinancialJson: () => findInvalidFinancialJson(scoped),
      // Two UNION ALL queries over 34 indexed FK joins. Sits in this group
      // rather than its own because the cost is I/O, not the CPU the other
      // groups exist to isolate — and it shares this fan-out's single
      // connection.
      referentialLivenessViolations: () =>
        findReferentialLivenessViolations(scoped),
    }),
  );
  return {
    duplicateUniqueProducts: r.duplicateUniqueProducts,
    orphanedProducts: r.orphanedProducts,
    productsMissingPrice: r.productsMissingPrice.real,
    unvaluedBucketProducts: r.productsMissingPrice.buckets,
    productsWithoutMappings: r.productsWithoutMappings,
    ingredientsWithoutProduct: r.ingredientsWithoutProduct,
    unusedIngredientsWithProduct: r.unusedIngredients.withProduct,
    unusedIngredientsWithoutProduct: r.unusedIngredients.withoutProduct,
    emptyLocations: r.emptyLocations,
    productsWithNoImages: r.productsWithNoImages.map((p) => ({
      ...p,
      id: unsafeProductShortcode(p.shortcode),
    })),
    locationsWithoutAiDescription: r.locationsWithoutAiDescription,
    orphanedEntityEmbeddings: r.orphanedEntityEmbeddings,
    entitiesMissingEmbeddings: r.entitiesMissingEmbeddings,
    staleParentRecipes: r.staleParentRecipes,
    staleLocations: r.staleLocations,
    neverVerifiedInventory: r.neverVerifiedInventory,
    unknownParkedItems: r.unknownParkedItems,
    manufacturerSpellingVariants: r.manufacturerSpellingVariants,
    duplicateVendors: r.duplicateVendors,
    vendorsWithoutLogos: r.vendorsWithoutLogos,
    purchasesNotReconciling: r.purchasesNotReconciling,
    purchaseFinancialSettlementMismatches:
      r.purchaseFinancialSettlementMismatches,
    duplicateFinancialTransactionSourceRefs:
      r.duplicateFinancialTransactionSourceRefs,
    duplicateFinancialAccountSourceAliases:
      r.duplicateFinancialAccountSourceAliases,
    invalidFinancialJson: r.invalidFinancialJson,
    referentialLivenessViolations: r.referentialLivenessViolations,
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

// USDA-coverage group — both sections share one product scan + USDA enrichment.
export const findCoverageProblems = (
  db: Database,
  usdaClient: USDAClient,
): Promise<ProblemsCoverage> => findProductCoverageProblems(db, usdaClient);

// UPC-lookup network detector.
const findProductsWithBetterUpcData = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
): Promise<ProductWithBetterUpcData[]> => {
  const candidates = await findProductsWithUpcGaps(db);
  const lookups = await upcLookupClient.lookupBatch(
    candidates.map((c) => c.upc),
  );

  const problems: ProductWithBetterUpcData[] = [];
  for (const cand of candidates) {
    const lookup = lookups.get(cand.upc);
    if (!lookup) continue;

    const proposed = {
      manufacturer:
        isUnspecifiedManufacturer(cand.manufacturer) &&
        !isUnspecifiedManufacturer(lookup.manufacturer ?? lookup.brand)
          ? (lookup.manufacturer ?? lookup.brand)
          : null,
      price:
        cand.price == null && lookup.priceDollars != null
          ? lookup.priceDollars
          : null,
      imageUrl:
        !cand.hasImage && lookup.imageUrl
          ? new URL(lookup.imageUrl, env.UPC_LOOKUP_API_URL).toString()
          : null,
    };

    if (
      proposed.manufacturer == null &&
      proposed.price == null &&
      proposed.imageUrl == null
    ) {
      continue;
    }

    problems.push({
      id: cand.shortcode,
      name: cand.name,
      manufacturer: cand.manufacturer,
      upc: cand.upc,
      proposed,
    });
  }

  return problems;
};

// Household-tracker group — the seven attention rules the /projects overview
// already computes (overdue tasks, stalled projects, missing budgets, past-due
// planned expenses, unclassified expenses, blocked work, date-window
// drift), promoted to first-class Problems so the navbar badge / homepage
// banner / MCP see them.
// The detection itself stays in the repo (computeAttentionItems); this only
// splits the flat item list into the per-rule slices, keyed by the shared
// TRACKER_PROBLEM_KEY_BY_TYPE map so the two can't drift.
export const findTrackerProblems = async (
  db: Database,
): Promise<ProblemsTracker> => {
  const items = await computeAttentionItems(db);
  const tracker: ProblemsTracker = {
    overdueTasks: [],
    stalledProjects: [],
    projectsMissingBudget: [],
    pastDuePlannedExpenses: [],
    unclassifiedExpenses: [],
    blockedWorkProjects: [],
    projectsWithDateDrift: [],
  };
  for (const item of items) {
    tracker[TRACKER_PROBLEM_KEY_BY_TYPE[item.type]].push(item);
  }
  return tracker;
};

export const findUpcProblems = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
): Promise<ProblemsUpc> => ({
  productsWithBetterUpcData: await findProductsWithBetterUpcData(
    db,
    upcLookupClient,
  ),
});

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
  });
  return assembleAllProblems(groups);
};
