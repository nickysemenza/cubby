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
import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import type {
  AllProblems,
  IngredientWithPartialCoverage,
  MaintenanceCounts,
  ProductWithIslandedMappings,
} from "@cubby/schemas/problems";
import { isMiscProduct } from "@cubby/shared";
import { sum, uniq, uniqBy } from "es-toolkit";
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
import type { Database } from "~/server/db";
import {
  deleteIngredients,
  findOrCreateIngredient,
} from "~/server/repo/ingredient";
import {
  applyReparsedStaleLines,
  findDuplicateUniqueProducts,
  findEmptyLocations,
  findIngredientsWithoutProduct,
  findIngredientsWithUnusedAliases,
  findLinkedProductIds,
  findLocationsWithoutAiDescription,
  findOrphanedProducts,
  findProductsWithBetterUpcData,
  findProductsWithoutMappings,
  findStaleIngredientParses,
  findUnusedIngredients,
  loadProductsForCoverage,
  type ReparsedStaleLineWrite,
  synthesizeEffectiveMappings,
} from "~/server/repo/problems";
import {
  deleteProducts,
  findProductsWithNoImages,
} from "~/server/repo/product";
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import { batchEnrichWithFood } from "~/server/services/usda-helpers";
import { traceAll } from "~/server/tracing";

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
  const partialCandidates = products.filter(
    (p) =>
      p.ingredientId != null &&
      !isMiscProduct(p.name) &&
      (p.price != null ||
        p.fdc_id != null ||
        p.upc != null ||
        p.unitMappings.length > 0),
  );
  const islandedCandidates = products.filter(
    (p) =>
      p.unitMappings.length >= 2 &&
      !isMiscProduct(p.name) &&
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
    enriched.map((p) => [p.id, synthesizeEffectiveMappings(p)]),
  );

  const ingredientsWithPartialCoverage: IngredientWithPartialCoverage[] = [];
  for (const cand of partialCandidates) {
    const p = enrichedById.get(cand.id);
    const effective = p ? effectiveById.get(p.id) : null;
    if (!p || !effective) continue;

    // partialCandidates guarantees ingredientId != null; narrow for the
    // non-nullable schema field.
    if (p.ingredientId == null) continue;

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
      id: p.id,
      name: p.name,
      manufacturer: p.manufacturer,
      coverage: { covered: [...cov.covered], applicable: [...applicable] },
      hasPrice,
      hasUsdaLink: p.food != null,
      usdaUnavailable: p.usdaUnavailable ?? false,
      ingredientId: p.ingredientId,
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
        id: p.id,
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

  const recipesAffected = uniq(stale.map((s) => s.recipeId));
  yield { done: stale.length, total: stale.length };
  return { updated: stale.length, recipesAffected };
}

// Delete unused ingredients (per-card or bulk). When `alsoDeleteProducts`, each
// ingredient's non-deleted products are deleted FIRST so deleteIngredients'
// linked-product guard passes. Processed per ingredient so one failure (e.g. a
// product with inventory → PRODUCT_HAS_INVENTORY) is reported, not fatal to the
// batch.
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

// Counts for the Settings → Maintenance "N affected" dry-run. Runs only the
// detectors behind that panel's buttons — all DB/WASM, no USDA/UPC network — so
// it's far cheaper than a full findAllProblems scan. Recompute is a forced full
// pass, so its number is every active recipe, not just the stale ones.
export const findMaintenanceCounts = async (
  db: Database,
): Promise<MaintenanceCounts> => {
  const r = await traceAll({
    staleIngredientParses: () => findStaleIngredientParses(db),
    productsWithNoImages: () =>
      findProductsWithNoImages(db, { excludeIngredients: true }),
    locationsWithoutAiDescription: () => findLocationsWithoutAiDescription(db),
  });

  return {
    staleIngredientParses: r.staleIngredientParses.length,
    // Deliberately a SUBSET of the Problems-page productsWithNoImages count:
    // backfillUPCImages can only act on products that have a UPC to look up, so
    // this counts just those. Same canonical key, intentionally narrower number.
    productsWithNoImages: r.productsWithNoImages.filter((p) => p.upc != null)
      .length,
    locationsWithoutAiDescription: r.locationsWithoutAiDescription.length,
  };
};

// Main function to get all problems
export const findAllProblems = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
  usdaClient: USDAClient,
): Promise<AllProblems> => {
  // Run all checks in parallel, each in its own trace span (the key names the
  // span — see traceAll). Better performance + per-detector observability.
  const r = await traceAll({
    duplicateUniqueProducts: () => findDuplicateUniqueProducts(db),
    orphanedProducts: () => findOrphanedProducts(db),
    productsWithoutMappings: () => findProductsWithoutMappings(db),
    // Both coverage detectors share one product scan + USDA enrichment.
    productCoverage: () => findProductCoverageProblems(db, usdaClient),
    ingredientsWithoutProduct: () => findIngredientsWithoutProduct(db),
    ingredientsWithUnusedAliases: () => findIngredientsWithUnusedAliases(db),
    unusedIngredients: () => findUnusedIngredients(db),
    emptyLocations: () => findEmptyLocations(db),
    productsWithNoImages: () =>
      findProductsWithNoImages(db, { excludeIngredients: true }),
    locationsWithoutAiDescription: () => findLocationsWithoutAiDescription(db),
    staleIngredientParses: () => findStaleIngredientParses(db),
    productsWithBetterUpcData: () =>
      findProductsWithBetterUpcData(db, upcLookupClient),
  });

  const sections = {
    duplicateUniqueProducts: r.duplicateUniqueProducts,
    orphanedProducts: r.orphanedProducts,
    productsWithoutMappings: r.productsWithoutMappings,
    ingredientsWithPartialCoverage:
      r.productCoverage.ingredientsWithPartialCoverage,
    ingredientsWithoutProduct: r.ingredientsWithoutProduct,
    ingredientsWithUnusedAliases: r.ingredientsWithUnusedAliases,
    unusedIngredientsWithProduct: r.unusedIngredients.withProduct,
    unusedIngredientsWithoutProduct: r.unusedIngredients.withoutProduct,
    emptyLocations: r.emptyLocations,
    productsWithNoImages: r.productsWithNoImages,
    productsWithIslandedMappings:
      r.productCoverage.productsWithIslandedMappings,
    locationsWithoutAiDescription: r.locationsWithoutAiDescription,
    staleIngredientParses: r.staleIngredientParses,
    productsWithBetterUpcData: r.productsWithBetterUpcData,
  };

  // totalProblems is the sum of every section length — derived, never
  // hand-summed, so adding a detector can't silently undercount the badge.
  return {
    ...sections,
    totalProblems: sum(Object.values(sections).map((items) => items.length)),
  };
};
