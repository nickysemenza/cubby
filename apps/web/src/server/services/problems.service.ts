import type { ActorContext } from "@cubby/schemas/context";
/** Problems service composes detector repos and cross-entity services without direct database access. */
import {
  type IngredientId,
  parseEntityId,
  type ProductId,
  parseShortcodeFor,
  type RecipeId,
} from "@cubby/schemas/identifiers";
import { CULL_PENDING_IMAGES_DEFAULT_HOURS } from "@cubby/schemas/image";
import { measureEstimate, estimateCoverage } from "@cubby/schemas/nutrition";
import {
  allProblemsSchema,
  type CoverageTotals,
  type IngredientWithPartialCoverage,
  ingredientWithPartialCoverageSchema,
  type MaintenanceCounts,
  type ProblemKey,
  type ProblemsCount,
  type ProblemsCoverage,
  type ProblemsFast,
  type ProblemsTracker,
  type ProblemsUpc,
  type ProductWithBetterUpcData,
  type ProductWithIslandedMappings,
  problemsCountSchema,
  productWithBetterUpcDataSchema,
  productWithIslandedMappingsSchema,
  TRACKER_PROBLEM_KEY_BY_TYPE,
} from "@cubby/schemas/problems";
import type {
  ProjectAttentionItem,
  ProjectAttentionType,
} from "@cubby/schemas/project";
import {
  projectAttentionItemSchema,
  projectAttentionTypeSchema,
} from "@cubby/schemas/project";
import { purchaseOut } from "@cubby/schemas/purchase";
import { isMiscProduct, isNonFoodCategory } from "@cubby/shared";
import { sum, uniq, uniqBy } from "es-toolkit";
import { z } from "zod";

import { problemQueryDeclarations } from "~/entities/problem-registry";
import {
  BASE_KINDS,
  conversionCoverage,
  gradedKinds,
} from "~/lib/conversion-coverage";
import { getErrorMessage } from "~/lib/error-utils";
import { isMoneyUnit } from "~/lib/price-mapping-utils";
import { wasm } from "~/lib/wasm";
import { type Database, withConnection } from "~/server/db";
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
  countProductsWithNoImagesWithGtin,
  deleteProducts,
  getProductConversionCoverageFreshness,
  loadProductConversionCoverageProjection,
  type ProductConversionCoverageFreshness,
  type ProductConversionCoverageProjection,
  writeProductConversionCoverageProjection,
} from "~/server/repo/product";
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import { computeAttentionItems } from "~/server/repo/project/attention";
import { countStaleRecipeTotals } from "~/server/repo/recipe/totals";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import {
  type DiagnosticRunOptions,
  type DiagnosticSampleResult,
  type UpcLookupBatchPort,
  runDiagnostic,
} from "~/server/services/problem-diagnostics.service";
import {
  countViewProblem,
  executeProblem,
} from "~/server/services/problem-views.service";
import type { UsdaFoodBatchPort } from "~/server/services/usda-helpers";
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
  usdaClient: UsdaFoodBatchPort,
): Promise<{
  ingredientsWithPartialCoverage: IngredientWithPartialCoverage[];
  productsWithIslandedMappings: ProductWithIslandedMappings[];
  projection: ProductConversionCoverageProjection[];
}> => {
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
        p.primaryGtin != null ||
        p.unitMappings.length > 0),
  );
  const islandedCandidates = products.filter(
    (p) =>
      p.unitMappings.length >= 2 &&
      !isMiscProduct(p.name) &&
      !isNonFoodCategory(p.category) &&
      wasm.detect_unit_mapping_islands(p.unitMappings).length >= 2,
  );

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
        id: parseShortcodeFor("product", p.shortcode),
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
      id: parseShortcodeFor("product", p.shortcode),
      name: p.name,
      manufacturer: p.manufacturer,
      coverage: { covered: [...cov.covered], applicable: [...applicable] },
      hasPrice,
      hasUsdaLink: p.food != null || p.labelNutrition != null,
      usdaUnavailable: p.usdaUnavailable ?? false,
      ingredientId: parseShortcodeFor("ingredient", p.ingredient.shortcode),
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
        id: parseShortcodeFor("product", p.shortcode),
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
const rebuildProductConversionCoverageProjection = async (
  db: Database,
  usdaClient: UsdaFoodBatchPort,
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
export const selectStaleIngredientParses = findStaleIngredientParses;

/** Apply the selected stale-parse set in one transaction. */
export const reparseStaleIngredientParsesBatch = async (
  db: Database,
  stale: Awaited<ReturnType<typeof findStaleIngredientParses>>,
): Promise<{ updated: number; recipesAffected: RecipeId[] }> => {
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
    if (row.nameDrift)
      values.ingredientId = idByName.get(row.parsedName.toLowerCase());
    return { recipeSectionIngredientId: row.recipeSectionIngredientId, values };
  });
  await applyReparsedStaleLines(db, writes);
  return {
    updated: stale.length,
    recipesAffected: uniq(stale.map((s) => s.recipeEntityId)),
  };
};

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

export const findMaintenanceCounts = async (
  db: Database,
): Promise<MaintenanceCounts> => {
  const r = await traceAll({
    productsWithNoImages: () => countProductsWithNoImagesWithGtin(db),
    locationsWithoutAiDescription: () =>
      countViewProblem(db, "locationsWithoutAiDescription"),
    staleRecipeTotals: () => countStaleRecipeTotals(db),
    cullablePendingImages: () =>
      countCullablePendingImages(db, CULL_PENDING_IMAGES_DEFAULT_HOURS),
    entitiesMissingEmbeddings: () => countMissingEmbeddings(db),
  });

  return {
    productsWithNoImages: r.productsWithNoImages,
    locationsWithoutAiDescription: r.locationsWithoutAiDescription,
    staleRecipeTotals: r.staleRecipeTotals,
    cullablePendingImages: r.cullablePendingImages,
    entitiesMissingEmbeddings: r.entitiesMissingEmbeddings,
  };
};

// Parse sweeps are maintenance-only; never add them to the Problems hot path.
export const dryRunReparse = async (
  db: Database,
): Promise<{ wouldChange: number; total: number }> => {
  const [stale, total] = await Promise.all([
    findStaleIngredientParses(db),
    countReparseableLines(db),
  ]);
  return { wouldChange: stale.length, total };
};

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
// them in one pass. The WASM sweep is the slow part; the prune itself is a
// single transaction.
export const selectIngredientsWithUnusedAliases =
  findIngredientsWithUnusedAliases;

/** Prune the selected alias set in one transaction. */
export const pruneUnusedIngredientAliasesBatch = async (
  db: Database,
  items: Awaited<ReturnType<typeof findIngredientsWithUnusedAliases>>,
): Promise<{ pruned: number }> => {
  const resolved = await resolveLiveShortcodes(
    db,
    items.map((item) => item.id),
    "ingredient",
  );
  return pruneUnusedAliases(
    db,
    items.flatMap((item) => {
      const entityId = resolved.get(item.id);
      return entityId
        ? [
            {
              ingredientId: parseEntityId("ingredient", entityId),
              remove: item.unusedAliases,
            },
          ]
        : [];
    }),
  );
};

type ExactProblemPage = Awaited<ReturnType<typeof executeProblem>>;

/**
 * Lane orchestration never chooses a detector directly for derived Problems.
 * The typed diagnostic adapter is the sole dispatch point; this cast only
 * restores the existing card-presenter row type after that boundary.
 */
const diagnosticItems = async <T extends readonly unknown[]>(
  db: Database,
  diagnostic: Parameters<typeof runDiagnostic>[1],
  itemsSchema: z.ZodType<T>,
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
  return { ...result, items: itemsSchema.parse(result.items) };
};

const runExactProblemPages = async (
  db: Database,
  keys: readonly ProblemKey[],
  options?: {
    projectionFreshness?: ProductConversionCoverageFreshness;
    concurrency?: number;
    diagnostic?: DiagnosticRunOptions;
  },
): Promise<Partial<Record<ProblemKey, ExactProblemPage>>> => {
  const tasks: Record<string, () => Promise<ExactProblemPage>> = {};
  for (const key of keys) {
    tasks[key] = () =>
      executeProblem(db, key, {
        projectionFreshness: options?.projectionFreshness,
        diagnostic: options?.diagnostic,
      });
  }
  return await traceAllBounded(tasks, options?.concurrency ?? 4);
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
  usdaClient: UsdaFoodBatchPort,
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
  const ids = [...idsByCode.values()];
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
    const productId = idsByCode.get(row.id);
    const coverage = productId ? projection.get(productId) : undefined;
    if (!product || !coverage || product.ingredient?.shortcode == null) {
      throw new Error(
        `Canonical conversion coverage Problem selected ${row.id}, but bounded presentation hydration was incomplete`,
      );
    }
    return ingredientWithPartialCoverageSchema.parse({
      id: parseShortcodeFor("product", product.shortcode),
      name: product.name,
      manufacturer: product.manufacturer,
      coverage: {
        covered: coverage.coveredKinds,
        applicable: coverage.applicableKinds,
      },
      hasPrice: product.price != null,
      hasUsdaLink: product.food != null || product.labelNutrition != null,
      usdaUnavailable: product.usdaUnavailable ?? false,
      ingredientId: parseShortcodeFor(
        "ingredient",
        product.ingredient.shortcode,
      ),
    });
  });
  const islands = islandPage.data.map((row) => {
    const product = byCode.get(row.id);
    const productId = idsByCode.get(row.id);
    const coverage = productId ? projection.get(productId) : undefined;
    if (!product || !coverage) {
      throw new Error(
        `Canonical mapping-island Problem selected ${row.id}, but bounded presentation hydration was incomplete`,
      );
    }
    const effective = synthesizeEffectiveMappings({
      ...product,
      id: parseShortcodeFor("product", product.shortcode),
    });
    // A transient presentation-time USDA miss must not change the already
    // selected projection membership. Fall back to stored maps for the card's
    // examples; the persisted island count remains authoritative.
    const islandUnits = wasm.detect_unit_mapping_islands(
      effective ?? product.unitMappings,
    );
    return productWithIslandedMappingsSchema.parse({
      id: parseShortcodeFor("product", product.shortcode),
      name: product.name,
      manufacturer: product.manufacturer,
      islandCount: coverage.islandCount,
      islands: islandUnits.map((units) => ({
        units: units.slice(0, 3),
        exampleUnit: units[0] ?? "unknown",
      })),
      coverage: {
        covered: coverage.coveredKinds,
        applicable: coverage.applicableKinds,
      },
    });
  });
  return {
    ingredientsWithPartialCoverage: partial,
    productsWithIslandedMappings: islands,
  };
};

const exactProblemPresentationRowSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  manufacturer: z.string().nullish(),
  expectedQuantity: z.number().nullish(),
  inventoryEntry: z
    .array(
      z.object({
        amount: z.object({ value: z.number().optional() }).optional(),
        location: z
          .object({ id: z.string().optional(), name: z.string().optional() })
          .nullish(),
      }),
    )
    .nullish(),
  onHandUnits: z.number().nullish(),
  cost: z.number().nullish(),
  date: z.string().nullish(),
  purchaseId: z.string().nullish(),
  vendor: z.string().nullish(),
  projectName: z.string().nullish(),
  primaryGtin: z.string().nullish(),
  quantityLedger: z
    .object({ expectedQuantity: z.number().optional() })
    .nullish(),
  createdAt:
    allProblemsSchema.shape.unknownParkedItems.element.shape.createdAt.nullish(),
  recipes: z
    .array(
      z.object({
        recipe: z
          .object({
            id: z.string(),
            name: z.string(),
            totals: z
              .object({
                cost: measureEstimate,
              })
              .nullish(),
          })
          .optional(),
      }),
    )
    .nullish(),
  amount:
    allProblemsSchema.shape.unknownParkedItems.element.shape.amount.optional(),
  product: allProblemsSchema.shape.unknownParkedItems.element.shape.product
    .extend({ effectivePrice: z.number().nullish() })
    .optional(),
  location:
    allProblemsSchema.shape.unknownParkedItems.element.shape.location.optional(),
  website: z.string().nullish(),
  purchaseCount: z.number().nullish(),
  vendorName: z.string().nullish(),
  orderId: z.string().nullish(),
  orderUrl: z.string().nullish(),
  statedTotal: z.number().nullish(),
  expenseTotal: z.number().nullish(),
  expenseCount: z.number().nullish(),
  unpricedExpenseCount: z.number().nullish(),
  reconciliation: purchaseOut.shape.reconciliation.nullish(),
  financialReconciliation: purchaseOut.shape.financialReconciliation.nullish(),
});

type FastProblemCard = ProblemsFast[FastEntityProblemKey][number];
type ExactProblemPresentationRow = z.infer<
  typeof exactProblemPresentationRowSchema
>;
type FastProblemHydration = {
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
};

const inventoryLocations = (row: ExactProblemPresentationRow) =>
  (row.inventoryEntry ?? []).flatMap((entry) =>
    entry.location?.id && entry.location.name
      ? [{ id: entry.location.id, name: entry.location.name }]
      : [],
  );

type FastExactPresenter = (
  row: ExactProblemPresentationRow,
  hydration: FastProblemHydration | undefined,
) => FastProblemCard;

const fastExactPresenters = {
  duplicateInventory: (row) =>
    allProblemsSchema.shape.duplicateInventory.element.parse({
      id: row.id,
      name: String(row.name),
      manufacturer: String(row.manufacturer ?? ""),
      expectedQuantity: row.expectedQuantity ?? null,
      locations: inventoryLocations(row),
    }),
  soldButStillStocked: (row, hydration) => {
    const totals = hydration?.soldTotals?.get(row.id);
    if (!totals) {
      throw new Error(
        `Canonical sold-but-stocked Problem selected ${row.id}, but bounded presentation hydration found no row`,
      );
    }
    return allProblemsSchema.shape.soldButStillStocked.element.parse({
      id: row.id,
      name: String(row.name),
      manufacturer: String(row.manufacturer ?? ""),
      soldQuantity: totals.soldQuantity,
      liveQuantity: Number(row.onHandUnits ?? 0),
      proceeds: totals.proceeds,
      locations: uniqBy(
        [...inventoryLocations(row), ...totals.servingLocations],
        (location) => location.id,
      ),
    });
  },
  unlinkedExitExpenses: (row) =>
    allProblemsSchema.shape.unlinkedExitExpenses.element.parse({
      id: row.id,
      name: String(row.name),
      cost: Number(row.cost),
      date: row.date ?? null,
      purchaseId: String(row.purchaseId),
      vendorName: row.vendor ?? null,
    }),
  purchaselessExitExpenses: (row) =>
    allProblemsSchema.shape.purchaselessExitExpenses.element.parse({
      id: row.id,
      name: String(row.name),
      cost: Number(row.cost),
      date: row.date ?? null,
      projectName: row.projectName ?? null,
    }),
  productsWithNoImages: (row) =>
    allProblemsSchema.shape.productsWithNoImages.element.parse({
      id: row.id,
      name: String(row.name),
      manufacturer: String(row.manufacturer ?? ""),
      primaryGtin: row.primaryGtin ?? null,
    }),
  kitsCountedTwice: (row) =>
    allProblemsSchema.shape.kitsCountedTwice.element.parse({
      id: row.id,
      name: String(row.name),
      manufacturer: String(row.manufacturer ?? ""),
      ownUnits: Number(row.onHandUnits ?? 0),
      expectedUnits: Number(row.quantityLedger?.expectedQuantity ?? 0),
    }),
  understatedCostMeals: (row) => {
    const affectedRecipes = (row.recipes ?? []).flatMap((entry) => {
      const recipe = entry.recipe;
      const cost = recipe?.totals?.cost;
      const coverage = cost ? estimateCoverage(cost) : undefined;
      return recipe && coverage && coverage.covered < coverage.total
        ? [
            {
              id: recipe.id,
              name: recipe.name,
              costCovered: coverage.covered,
              ingredientCount: coverage.total,
            },
          ]
        : [];
    });
    return allProblemsSchema.shape.understatedCostMeals.element.parse({
      id: row.id,
      name: row.name ?? null,
      date: row.date,
      affectedRecipes,
      recipeCount: affectedRecipes.length,
    });
  },
  unknownParkedItems: (row) =>
    allProblemsSchema.shape.unknownParkedItems.element.parse({
      id: row.id,
      amount: row.amount,
      createdAt: row.createdAt,
      product: row.product,
      location: row.location,
    }),
  inventoryWithoutPricePath: (row) =>
    allProblemsSchema.shape.inventoryWithoutPricePath.element.parse({
      id: row.id,
      amount: row.amount,
      effectivePrice: Number(row.product?.effectivePrice ?? 0),
      product: row.product,
      location: row.location,
    }),
  vendorsWithoutLogos: (row, hydration) => {
    const counts = hydration?.vendorExpenseCounts?.get(row.id);
    if (!counts) {
      throw new Error(
        `Canonical vendor-logo Problem selected ${row.id}, but bounded presentation hydration found no row`,
      );
    }
    return allProblemsSchema.shape.vendorsWithoutLogos.element.parse({
      id: row.id,
      name: String(row.name),
      website: row.website ?? null,
      purchaseCount: Number(row.purchaseCount ?? 0),
      expenseRowCount: counts.expenseRowCount,
    });
  },
  purchasesNotReconciling: (row) =>
    allProblemsSchema.shape.purchasesNotReconciling.element.parse({
      id: row.id,
      vendorName: row.vendorName ?? null,
      orderId: row.orderId ?? null,
      orderUrl: row.orderUrl ?? null,
      date: row.date ?? null,
      statedTotal: Number(row.statedTotal),
      expenseTotal: Number(row.expenseTotal),
      expenseCount: Number(row.expenseCount),
      unpricedExpenseCount: Number(row.unpricedExpenseCount),
      postedRefundTotal: Number(
        row.financialReconciliation?.postedRefundTotal ?? 0,
      ),
    }),
  purchaseFinancialSettlementMismatches: (row) =>
    allProblemsSchema.shape.purchaseFinancialSettlementMismatches.element.parse(
      {
        id: row.id,
        vendorName: row.vendorName ?? null,
        expenseTotal: Number(row.expenseTotal),
        financialReconciliation: row.financialReconciliation,
      },
    ),
  financialTransactionAllocationDefects: (row, hydration) => {
    const hydrated = hydration?.allocationDefects?.get(row.id);
    if (hydrated) return hydrated;
    throw new Error(
      `Canonical allocation Problem selected ${row.id}, but bounded presentation hydration found no row`,
    );
  },
} satisfies Record<FastEntityProblemKey, FastExactPresenter>;

/**
 * Card-only projections for exact fast Problems.
 *
 * The entity list has already chosen these rows.  This function is deliberately
 * just a field projection: no predicate, grouping, or ordering may enter here.
 * Keeping it next to the lane makes that boundary reviewable and prevents a
 * rich card from accidentally becoming a second detector.
 */
const presentFastExactRows = (
  key: FastEntityProblemKey,
  page: ExactProblemPage,
  hydration?: FastProblemHydration,
): FastProblemCard[] => {
  const present = fastExactPresenters[key];
  return page.data.map((row) =>
    present(exactProblemPresentationRowSchema.parse(row), hydration),
  );
};

/**
 * Exact Problem pages are generic list rows, so their card projections cross a
 * raw-data seam. Validate the projection against the declared wire schema
 * before returning it; callers never reconstruct branded card types with a
 * structural assertion.
 */
const presentFastExactProblem = <T>(
  key: FastEntityProblemKey,
  page: ExactProblemPage,
  itemsSchema: z.ZodType<T>,
  hydration?: FastProblemHydration,
): T => itemsSchema.parse(presentFastExactRows(key, page, hydration));

const presentSingleFastProblem = async (
  db: Database,
  key: (typeof FAST_ENTITY_PROBLEM_KEYS)[number],
  page: ExactProblemPage,
): Promise<unknown[]> => {
  if (key === "vendorsWithoutLogos") {
    return allProblemsSchema.shape.vendorsWithoutLogos.parse(
      presentFastExactRows(key, page, {
        vendorExpenseCounts: await loadVendorLogoPresenterCounts(
          db,
          page.data.map((row) => row.id),
        ),
      }),
    );
  }
  if (key === "soldButStillStocked") {
    return allProblemsSchema.shape.soldButStillStocked.parse(
      presentFastExactRows(key, page, {
        soldTotals: await loadSoldButStockedPresenterTotals(
          db,
          page.data.map((row) => row.id),
        ),
      }),
    );
  }
  if (key === "financialTransactionAllocationDefects") {
    return allProblemsSchema.shape.financialTransactionAllocationDefects.parse(
      presentFastExactRows(key, page, {
        allocationDefects: await loadAllocationDefectPresenters(
          db,
          page.data.map((row) => row.id),
        ),
      }),
    );
  }
  return allProblemsSchema.shape[key].parse(presentFastExactRows(key, page));
};

const FAST_ENTITY_PROBLEM_KEYS = [
  "duplicateInventory",
  "soldButStillStocked",
  "kitsCountedTwice",
  "unlinkedExitExpenses",
  "purchaselessExitExpenses",
  "productsWithNoImages",
  "understatedCostMeals",
  "unknownParkedItems",
  "inventoryWithoutPricePath",
  "vendorsWithoutLogos",
  "purchasesNotReconciling",
  "purchaseFinancialSettlementMismatches",
  "financialTransactionAllocationDefects",
] as const satisfies readonly ProblemKey[];

type FastEntityProblemKey = (typeof FAST_ENTITY_PROBLEM_KEYS)[number];

const isFastEntityProblemKey = (
  key: ProblemKey,
): key is (typeof FAST_ENTITY_PROBLEM_KEYS)[number] =>
  FAST_ENTITY_PROBLEM_KEYS.some((candidate) => candidate === key);

/** Fast Problems stays DB-only: no WASM or provider calls. */
export const findFastProblems = async (db: Database): Promise<ProblemsFast> => {
  const exactKeys = FAST_ENTITY_PROBLEM_KEYS;

  // Production traces show remote query waits in the 30–180ms range while a
  // checkout costs ~20ms. Run the derived and entity-backed branches together,
  // bounded to four tasks so the request-local max:5 pool retains one slot for
  // a list task's own count/hydration query.
  const [r, exact] = await Promise.all([
    traceAllBounded(
      {
        importFindings: () =>
          diagnosticItems(
            db,
            "import-findings",
            allProblemsSchema.shape.importFindings,
          ),
        duplicateProductIdentities: () =>
          diagnosticItems(
            db,
            "duplicate-product-identities",
            allProblemsSchema.shape.duplicateProductIdentities,
          ),
        orphanedProducts: () =>
          diagnosticItems(
            db,
            "orphaned-products",
            allProblemsSchema.shape.orphanedProducts,
          ),
        partiallyImportedCookbooks: () =>
          diagnosticItems(
            db,
            "partially-imported-cookbooks",
            allProblemsSchema.shape.partiallyImportedCookbooks,
          ),
        toolsUsedOutsideOwnership: () =>
          diagnosticItems(
            db,
            "tools-used-outside-ownership",
            allProblemsSchema.shape.toolsUsedOutsideOwnership,
          ),
        entitiesMissingEmbeddings: () =>
          diagnosticItems(
            db,
            "entities-missing-embeddings",
            allProblemsSchema.shape.entitiesMissingEmbeddings,
          ),
        staleParentRecipes: () =>
          diagnosticItems(
            db,
            "stale-parent-recipes",
            allProblemsSchema.shape.staleParentRecipes,
          ),
        weightSoldProducts: () =>
          diagnosticItems(
            db,
            "weight-sold-products",
            allProblemsSchema.shape.weightSoldProducts,
          ),
        manufacturerSpellingVariants: () =>
          diagnosticItems(
            db,
            "manufacturer-spelling-variants",
            allProblemsSchema.shape.manufacturerSpellingVariants,
          ),
        duplicateVendors: () =>
          diagnosticItems(
            db,
            "duplicate-vendors",
            allProblemsSchema.shape.duplicateVendors,
          ),
        duplicateSpendCandidates: () =>
          diagnosticItems(
            db,
            "duplicate-spend-candidates",
            allProblemsSchema.shape.duplicateSpendCandidates,
          ),
        duplicateFinancialTransactionSourceRefs: () =>
          diagnosticItems(
            db,
            "duplicate-financial-transaction-source-refs",
            allProblemsSchema.shape.duplicateFinancialTransactionSourceRefs,
          ),
        duplicateFinancialAccountSourceAliases: () =>
          diagnosticItems(
            db,
            "duplicate-financial-account-source-aliases",
            allProblemsSchema.shape.duplicateFinancialAccountSourceAliases,
          ),
        invalidFinancialJson: () =>
          diagnosticItems(
            db,
            "invalid-financial-json",
            allProblemsSchema.shape.invalidFinancialJson,
          ),
        incompleteStatementImports: () =>
          diagnosticItems(
            db,
            "incomplete-statement-imports",
            allProblemsSchema.shape.incompleteStatementImports,
          ),
        referentialLivenessViolations: () =>
          diagnosticItems(
            db,
            "referential-liveness-violations",
            allProblemsSchema.shape.referentialLivenessViolations,
          ),
        dependencyCycles: () =>
          diagnosticItems(
            db,
            "dependency-cycles",
            allProblemsSchema.shape.dependencyCycles,
          ),
      },
      2,
    ),
    runExactProblemPages(db, exactKeys, { concurrency: 2 }),
  ]);
  const legacy = {
    importFindings: r.importFindings.items,
    duplicateProductIdentities: r.duplicateProductIdentities.items,
    orphanedProducts: r.orphanedProducts.items,
    partiallyImportedCookbooks: r.partiallyImportedCookbooks.items,
    toolsUsedOutsideOwnership: r.toolsUsedOutsideOwnership.items,
    entitiesMissingEmbeddings: r.entitiesMissingEmbeddings.items,
    staleParentRecipes: r.staleParentRecipes.items,
    weightSoldProducts: r.weightSoldProducts.items,
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
    dependencyCycles: r.dependencyCycles.items,
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
    duplicateInventory: presentFastExactProblem(
      "duplicateInventory",
      page("duplicateInventory"),
      allProblemsSchema.shape.duplicateInventory,
    ),
    soldButStillStocked: presentFastExactProblem(
      "soldButStillStocked",
      page("soldButStillStocked"),
      allProblemsSchema.shape.soldButStillStocked,
      hydration,
    ),
    kitsCountedTwice: presentFastExactProblem(
      "kitsCountedTwice",
      page("kitsCountedTwice"),
      allProblemsSchema.shape.kitsCountedTwice,
    ),
    unlinkedExitExpenses: presentFastExactProblem(
      "unlinkedExitExpenses",
      page("unlinkedExitExpenses"),
      allProblemsSchema.shape.unlinkedExitExpenses,
    ),
    purchaselessExitExpenses: presentFastExactProblem(
      "purchaselessExitExpenses",
      page("purchaselessExitExpenses"),
      allProblemsSchema.shape.purchaselessExitExpenses,
    ),
    productsWithNoImages: presentFastExactProblem(
      "productsWithNoImages",
      page("productsWithNoImages"),
      allProblemsSchema.shape.productsWithNoImages,
    ),
    understatedCostMeals: presentFastExactProblem(
      "understatedCostMeals",
      page("understatedCostMeals"),
      allProblemsSchema.shape.understatedCostMeals,
    ),
    unknownParkedItems: presentFastExactProblem(
      "unknownParkedItems",
      page("unknownParkedItems"),
      allProblemsSchema.shape.unknownParkedItems,
    ),
    inventoryWithoutPricePath: presentFastExactProblem(
      "inventoryWithoutPricePath",
      page("inventoryWithoutPricePath"),
      allProblemsSchema.shape.inventoryWithoutPricePath,
    ),
    vendorsWithoutLogos: presentFastExactProblem(
      "vendorsWithoutLogos",
      page("vendorsWithoutLogos"),
      allProblemsSchema.shape.vendorsWithoutLogos,
      hydration,
    ),
    purchasesNotReconciling: presentFastExactProblem(
      "purchasesNotReconciling",
      page("purchasesNotReconciling"),
      allProblemsSchema.shape.purchasesNotReconciling,
    ),
    purchaseFinancialSettlementMismatches: presentFastExactProblem(
      "purchaseFinancialSettlementMismatches",
      page("purchaseFinancialSettlementMismatches"),
      allProblemsSchema.shape.purchaseFinancialSettlementMismatches,
    ),
    financialTransactionAllocationDefects: presentFastExactProblem(
      "financialTransactionAllocationDefects",
      page("financialTransactionAllocationDefects"),
      allProblemsSchema.shape.financialTransactionAllocationDefects,
      hydration,
    ),
    sectionTotals: { ...derivedTotals, ...exactSectionTotals(exact) },
  };
};

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
  usdaClient: UsdaFoodBatchPort,
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
  const titleSized = await diagnosticItems(
    db,
    "title-derivable-unit-size",
    allProblemsSchema.shape.productsWithTitleDerivableSize,
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

const findProductsWithBetterUpcData = async (
  db: Database,
  upcLookupClient: UpcLookupBatchPort,
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
    products: productWithBetterUpcDataSchema.array().parse(result.items),
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

const trackerTypeFor = (key: TrackerEntityProblemKey): ProjectAttentionType => {
  const entry = Object.entries(TRACKER_PROBLEM_KEY_BY_TYPE).find(
    ([, problemKey]) => problemKey === key,
  );
  if (!entry) throw new Error(`No attention type declared for "${key}"`);
  return projectAttentionTypeSchema.parse(entry[0]);
};

const isTrackerEntityProblemKey = (
  key: ProblemKey,
): key is TrackerEntityProblemKey =>
  key !== "projectsWithDateDrift" &&
  TRACKER_PROBLEM_KEYS.some((candidate) => candidate === key);

const indexAttentionItems = (
  items: readonly ProjectAttentionItem[],
): Map<string, ProjectAttentionItem> =>
  new Map(
    items
      .filter((item) => item.type !== "date_window_drift")
      .map((item) => [`${item.type}:${item.entityId}`, item]),
  );

/**
 * Presentation only. Membership, order and count come from the canonical exact
 * page; this looks each selected row up in the rule engine's own output so the
 * Problems page shows the SAME measurements and wording as the projects
 * dashboard and the MCP tools.
 *
 * It used to rebuild the row from the generic list columns instead, which is how
 * the two drifted: every measurement was dropped, `blocked_work` came out `info`
 * rather than `warning`, and `stalled_project` reported `project.updatedAt` — a
 * value `attention.ts` documents at length as meaningless — as a UTC day.
 */
const presentTrackerProblem = (
  key: TrackerEntityProblemKey,
  page: ExactProblemPage,
  index: Map<string, ProjectAttentionItem>,
): ProjectAttentionItem[] => {
  const type = trackerTypeFor(key);
  return page.data.flatMap((row) => {
    const id = z.object({ id: z.string() }).parse(row).id;
    const item = index.get(`${type}:${id}`);
    // A miss is a benign race, not an invariant break: membership and the rule
    // engine each evaluate `householdLocalDate()` independently, so a request
    // straddling local midnight can legitimately disagree about "overdue".
    // Dropping the row is right — the rule engine is the authority on what the
    // row would say, and inventing a half-measured card is what the old
    // presenter did. The count still comes from the page, so a dropped row is
    // visible as a count/rows mismatch rather than silently wrong prose.
    return item ? [item] : [];
  });
};

export const findTrackerProblems = async (
  db: Database,
): Promise<ProblemsTracker> => {
  const exactKeys = TRACKER_PROBLEM_KEYS;
  const attentionItems = await computeAttentionItems(db);
  const exact = await runExactProblemPages(db, exactKeys, {
    diagnostic: { attentionItems },
  });
  const index = indexAttentionItems(attentionItems);
  const page = (key: (typeof exactKeys)[number]): ExactProblemPage => {
    const result = exact[key];
    if (!result) throw new Error(`Missing canonical Problem result "${key}"`);
    return result;
  };
  return {
    overdueTasks: presentTrackerProblem(
      "overdueTasks",
      page("overdueTasks"),
      index,
    ),
    stalledProjects: presentTrackerProblem(
      "stalledProjects",
      page("stalledProjects"),
      index,
    ),
    projectsMissingBudget: presentTrackerProblem(
      "projectsMissingBudget",
      page("projectsMissingBudget"),
      index,
    ),
    pastDuePlannedExpenses: presentTrackerProblem(
      "pastDuePlannedExpenses",
      page("pastDuePlannedExpenses"),
      index,
    ),
    unclassifiedExpenses: presentTrackerProblem(
      "unclassifiedExpenses",
      page("unclassifiedExpenses"),
      index,
    ),
    blockedWorkProjects: presentTrackerProblem(
      "blockedWorkProjects",
      page("blockedWorkProjects"),
      index,
    ),
    projectsWithDateDrift: projectAttentionItemSchema
      .array()
      .parse(page("projectsWithDateDrift").items),
    sectionTotals: {
      ...exactSectionTotals(exact),
    },
  };
};

export const findUpcProblems = async (
  db: Database,
  upcLookupClient: UpcLookupBatchPort,
): Promise<ProblemsUpc> => {
  const {
    products: productsWithBetterUpcData,
    count,
    freshness,
  } = await findProductsWithBetterUpcData(db, upcLookupClient);
  return {
    productsWithBetterUpcData,
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
  upcLookupClient: UpcLookupBatchPort,
): Promise<ProblemsCount> =>
  (await findProblemCountsSnapshot(db, upcLookupClient)).counts;

export type ProblemCountsSnapshotResult = {
  counts: ProblemsCount;
  quality: "complete" | "degraded";
};

/** Count every Problem while preserving external-provider health for snapshots. */
export const findProblemCountsSnapshot = async (
  db: Database,
  upcLookupClient: UpcLookupBatchPort,
): Promise<ProblemCountsSnapshotResult> => {
  const declarations = problemQueryDeclarations();
  const tasks: Record<string, () => ReturnType<typeof executeProblem>> = {};
  for (const definition of declarations) {
    tasks[definition.key] = async () =>
      executeProblem(db, definition.key, {
        mode: "count",
        diagnostic: { upcLookupClient },
      });
  }
  const results = await traceAllBounded(tasks, 4);
  const byType = problemsCountSchema.shape.byType.parse(
    Object.fromEntries(
      declarations.map((definition) => [
        definition.key,
        Number(results[definition.key]?.count ?? 0),
      ]),
    ),
  );
  const totalFor = (problemClass: "defect" | "coverage") =>
    declarations.reduce(
      (total, definition) =>
        definition.problemClass === problemClass
          ? total + (byType[definition.key] ?? 0)
          : total,
      0,
    );
  return {
    counts: {
      total: totalFor("defect"),
      coverageTotal: totalFor("coverage"),
      byType,
    },
    quality:
      results.productsWithBetterUpcData?.status.state === "unavailable"
        ? "degraded"
        : "complete",
  };
};

/** Execute only one registry entry for focused MCP/problem consumers. */
export const findProblemByType = async (
  db: Database,
  key: ProblemKey,
  upcLookupClient: UpcLookupBatchPort,
  usdaClient: UsdaFoodBatchPort,
): Promise<{ type: ProblemKey; items: unknown[]; total: number }> => {
  const result = await executeProblem(db, key, {
    diagnostic: { upcLookupClient },
  });
  if (isFastEntityProblemKey(key)) {
    return {
      type: key,
      items: await presentSingleFastProblem(db, key, result),
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
  if (key !== "projectsWithDateDrift" && isTrackerEntityProblemKey(key)) {
    const index = indexAttentionItems(await computeAttentionItems(db));
    return {
      type: key,
      items: presentTrackerProblem(key, result, index),
      total: result.count,
    };
  }
  return { type: key, items: [...result.items], total: result.count };
};
