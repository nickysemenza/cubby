import { z } from "zod";
import { amount } from "./codec";
import { ingredientId, recipeId } from "./identifiers";
import { searchableEntityRefFields } from "./search";

// The four base measurement kinds a product's conversion graph can reach. The
// single source for the BaseKind union: the costing lib (conversion-coverage)
// re-exports BASE_KINDS/BaseKind from this, and the coverage-bearing problem
// schemas below carry the union natively (no parallel repo type needed).
export const baseKind = z.enum(["weight", "volume", "money", "calories"]);
export type BaseKind = z.infer<typeof baseKind>;

// Shared field fragments — the product-summary head and the coverage shape
// repeat across many item schemas, so declare the reusable field maps once.
const productProblemFields = {
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
};
// `covered` = kinds the graph can actually reach; `applicable` = the kinds graded
// against (BASE_KINDS minus the ingredient's N/A opt-outs). A kind in `applicable`
// but not `covered` is a real gap; a kind in neither is "not applicable" (—).
const coverageFields = {
  covered: z.array(baseKind),
  applicable: z.array(baseKind),
};

// Output schemas for each problem type.
export const duplicateUniqueProductSchema = z.object({
  ...productProblemFields,
  expectedQuantity: z.number().nullable(),
  locations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
});

export const orphanedProductSchema = z.object({
  ...productProblemFields,
  createdAt: z.date(),
});

export const productWithoutMappingsSchema = z.object({
  ...productProblemFields,
  createdAt: z.date(),
  isIngredient: z.boolean(),
  usdaUnavailable: z.boolean(),
  // The linked ingredient (null for non-food products), so the Problems card can
  // deep-link the ingredient-enrichment workbench to this exact row.
  ingredientId: ingredientId.nullable(),
});

export const ingredientWithPartialCoverageSchema = z.object({
  ...productProblemFields,
  coverage: z.object(coverageFields),
  hasPrice: z.boolean(),
  hasUsdaLink: z.boolean(),
  usdaUnavailable: z.boolean(),
  // Always set here (these rows are ingredient products) — see above.
  ingredientId,
});

export const ingredientWithoutProductSchema = z.object({
  id: ingredientId,
  name: z.string(),
  recipeCount: z.number(),
});

// An ingredient carrying ≥1 "unused" alias — one that's redundant (case-only dup
// of the name/another alias) or never matched by a recipe line. `aliases` is the
// full current list so the card can compute the keep-set; `unusedAliases` is the
// subset to strip (the delete removes only these, never the ingredient).
export const ingredientWithUnusedAliasesSchema = z.object({
  id: ingredientId,
  name: z.string(),
  aliases: z.array(z.string()),
  unusedAliases: z.array(z.string()),
});

// An ingredient used in no live recipe (and not a sub-recipe pointer). `products`
// lists its non-deleted linked products ([] for the "no product" section); the
// delete removes those products too.
export const unusedIngredientSchema = z.object({
  id: ingredientId,
  name: z.string(),
  createdAt: z.date(),
  products: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const emptyLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  createdAt: z.date(),
  lastBulkInventory: z.date().nullable(),
  aiDescription: z.string().nullable(),
  firstImageUrl: z.string().nullable(),
  firstImageId: z.string().nullable(),
});

export const productWithNoImagesSchema = z.object({
  ...productProblemFields,
  upc: z.string().nullable(),
});

export const productWithIslandedMappingsSchema = z.object({
  ...productProblemFields,
  islandCount: z.number(),
  islands: z.array(
    z.object({
      units: z.array(z.string()),
      exampleUnit: z.string(),
    }),
  ),
  coverage: z.object(coverageFields),
});

export const locationWithoutAiDescriptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  imageCount: z.number(),
});

export const orphanedEntityEmbeddingSchema = z.object({
  id: z.string(),
  ...searchableEntityRefFields,
  model: z.string(),
  createdAt: z.date(),
});

export const staleIngredientParseSchema = z.object({
  recipeSectionIngredientId: z.string(),
  recipeId,
  recipeName: z.string(),
  ingredientId,
  storedName: z.string(),
  rawLine: z.string(),
  parsedName: z.string(),
  nameDrift: z.boolean(),
  storedAmounts: z.array(amount),
  parsedAmounts: z.array(amount),
  amountDrift: z.boolean(),
  storedModifier: z.string().nullable(),
  parsedModifier: z.string().nullable(),
  modifierDrift: z.boolean(),
});

export const productWithBetterUpcDataSchema = z.object({
  ...productProblemFields,
  upc: z.string(),
  // Each field is set only when a fresh lookup would fill it (stored value empty
  // AND lookup has one). null ⇒ no change for that field. A row always has ≥1
  // non-null field. `imageUrl` is an absolute URL ready to render.
  proposed: z.object({
    manufacturer: z.string().nullable(),
    price: z.number().nullable(), // dollars, matches product.price + lookup.priceDollars
    imageUrl: z.string().nullable(),
  }),
});

// Grouped output shapes — the Problems page loads detectors in cost-grouped
// chunks (one tRPC query each, routed through an UNBATCHED link so each runs in
// its own Worker invocation/CPU budget; see root-provider.tsx). The groups split
// by cost: `fast` is all DB-only detectors; the rest isolate the heavier ones
// (USDA-coverage, UPC) so no single invocation sums all the CPU. The two WASM
// parse-sweeps (stale parses, unused aliases) are NOT here — they re-parse every
// recipe line and blew the CPU/memory budget on the request path, so they live as
// manual dry-run/fix-all actions in Settings → Maintenance instead.
const problemsFastShape = {
  duplicateUniqueProducts: z.array(duplicateUniqueProductSchema),
  orphanedProducts: z.array(orphanedProductSchema),
  productsWithoutMappings: z.array(productWithoutMappingsSchema),
  ingredientsWithoutProduct: z.array(ingredientWithoutProductSchema),
  unusedIngredientsWithProduct: z.array(unusedIngredientSchema),
  unusedIngredientsWithoutProduct: z.array(unusedIngredientSchema),
  emptyLocations: z.array(emptyLocationSchema),
  productsWithNoImages: z.array(productWithNoImagesSchema),
  locationsWithoutAiDescription: z.array(locationWithoutAiDescriptionSchema),
  orphanedEntityEmbeddings: z.array(orphanedEntityEmbeddingSchema),
};

// DB-only detectors — cheap, no WASM/network.
export const problemsFastSchema = z.object(problemsFastShape);

// USDA-coverage detectors — share one product scan + USDA enrichment.
const problemsCoverageShape = {
  ingredientsWithPartialCoverage: z.array(ingredientWithPartialCoverageSchema),
  productsWithIslandedMappings: z.array(productWithIslandedMappingsSchema),
};

export const problemsCoverageSchema = z.object(problemsCoverageShape);

// UPC-lookup network detector.
const problemsUpcShape = {
  productsWithBetterUpcData: z.array(productWithBetterUpcDataSchema),
};

export const problemsUpcSchema = z.object(problemsUpcShape);

// Combined output schema for all problems. It intentionally spells out the wire
// contract while sharing the grouped shapes above, so lazy loading/cost grouping
// never makes fields appear optional on the aggregate response.
const allProblemArrayFields = {
  ...problemsFastShape,
  ...problemsCoverageShape,
  ...problemsUpcShape,
};

export const allProblemsSchema = z.object({
  ...allProblemArrayFields,
  totalProblems: z.number(),
});

// Count-only output schema for badge display. byType derives mechanically from
// allProblemsSchema — every array key becomes a count — so the count roster
// can't drift from the set of detectors (the runtime derives it the same way).
const byTypeShape = Object.fromEntries(
  Object.keys(allProblemArrayFields).map((k) => [k, z.number()]),
) as { [K in keyof typeof allProblemArrayFields]: z.ZodNumber };

export const problemsCountSchema = z.object({
  total: z.number(),
  byType: z.object(byTypeShape),
});

export type AllProblems = z.infer<typeof allProblemsSchema>;
export type ProblemsFast = z.infer<typeof problemsFastSchema>;
export type ProblemsCoverage = z.infer<typeof problemsCoverageSchema>;
export type ProblemsUpc = z.infer<typeof problemsUpcSchema>;
export type ProblemsCount = z.infer<typeof problemsCountSchema>;

// ---------------------------------------------------------------------------
// Ignore ("I know, keep it") — a consciously-accepted problem (an intentional
// duplicate, an orphan you're keeping) should not re-appear on every visit. The
// user ignores a card; we persist a STABLE key and the detectors exclude it.
//
// A key is `${sectionId}:${itemId}` — the Problems-page section id (one per card
// group, stable + human-meaningful) plus the item's entity id. It's section-
// scoped so ignoring a product in "Missing images" doesn't also hide it in
// "Orphaned". `problemSectionArrayKeys` maps each section id to the AllProblems
// array field(s) it draws from, so the SERVER filter (which sees the raw arrays,
// not the section registry) and the CLIENT ignore action agree on the key.
// ---------------------------------------------------------------------------

/** The AllProblems array fields — every detector's output list. */
export type ProblemArrayKey = Exclude<keyof AllProblems, "totalProblems">;

/**
 * Section id → the AllProblems array key(s) whose items that section renders.
 * Mirrors the PROBLEM_SECTIONS registry's `select`s. The one many-to-one case is
 * `unit-coverage`, which merges three product/ingredient coverage arrays into a
 * single card group. Anything not listed here is un-ignorable (e.g. locations,
 * which the section renders through a custom component).
 */
export const problemSectionArrayKeys = {
  duplicates: ["duplicateUniqueProducts"],
  orphaned: ["orphanedProducts"],
  "unit-coverage": [
    "productsWithoutMappings",
    "ingredientsWithPartialCoverage",
    "productsWithIslandedMappings",
  ],
  "no-product-ingredients": ["ingredientsWithoutProduct"],
  "unused-with-product": ["unusedIngredientsWithProduct"],
  "unused-no-product": ["unusedIngredientsWithoutProduct"],
  images: ["productsWithNoImages"],
  "ai-descriptions": ["locationsWithoutAiDescription"],
  "orphaned-embeddings": ["orphanedEntityEmbeddings"],
  "upc-updates": ["productsWithBetterUpcData"],
} as const satisfies Record<string, readonly ProblemArrayKey[]>;

export type ProblemSectionId = keyof typeof problemSectionArrayKeys;

/** The persisted ignore key: `${sectionId}:${itemId}`. */
export const problemIgnoreKey = (sectionId: string, itemId: string): string =>
  `${sectionId}:${itemId}`;

export const ignoreProblemInput = z.object({
  sectionId: z.string(),
  itemId: z.string(),
});
export type IgnoreProblemInput = z.infer<typeof ignoreProblemInput>;

export const unignoreProblemInput = z.object({
  key: z.string(),
});

export const ignoredProblemOut = z.object({
  key: z.string(),
  sectionId: z.string(),
  itemId: z.string(),
  createdAt: z.date(),
});
export type IgnoredProblemOut = z.infer<typeof ignoredProblemOut>;

export const ignoredProblemsOut = z.array(ignoredProblemOut);

/**
 * Filter a partial bag of AllProblems arrays (one cost group, or the whole set)
 * against the ignored-key set. Each section's array key(s) are filtered by
 * `${sectionId}:${item.id}` membership. Non-array/absent keys pass through
 * untouched, so a group that only carries some arrays is safe to pass here.
 */
export const filterIgnoredFromArrays = <
  T extends Partial<Record<ProblemArrayKey, Array<{ id: string }>>> &
    Record<string, unknown>,
>(
  bag: T,
  ignoredKeys: ReadonlySet<string>,
): T => {
  if (ignoredKeys.size === 0) return bag;
  const out = { ...bag } as Record<string, unknown>;
  for (const [sectionId, arrayKeys] of Object.entries(
    problemSectionArrayKeys,
  )) {
    for (const key of arrayKeys) {
      const items = bag[key as keyof T];
      if (!Array.isArray(items)) continue;
      out[key] = items.filter(
        (item: { id: string }) =>
          !ignoredKeys.has(problemIgnoreKey(sectionId, item.id)),
      );
    }
  }
  return out as T;
};

// Derive the count payload from the full problems result: every array key
// becomes its length. The single source of truth for badge/count consumers, so
// they assemble the five cost-grouped queries and count locally (no re-scan).
export const countProblems = (all: AllProblems): ProblemsCount => {
  const { totalProblems, ...arrays } = all;
  const byType = Object.fromEntries(
    Object.entries(arrays).map(([key, items]) => [key, items.length]),
  ) as ProblemsCount["byType"];
  return { total: totalProblems, byType };
};

// Assemble the cost-grouped detector results into the combined AllProblems
// shape (with derived total). Shared by the service-layer findAllProblems
// aggregator and the MCP list_problems tool so the merge + total live in one
// place. (The Problems page merges client-side in useProblemsData, which is
// loading-aware and defaults not-yet-loaded groups to empty.)
export const assembleAllProblems = (groups: {
  fast: ProblemsFast;
  coverage: ProblemsCoverage;
  upc: ProblemsUpc;
}): AllProblems => {
  const sections = {
    ...groups.fast,
    ...groups.coverage,
    ...groups.upc,
  };
  const totalProblems = Object.values(sections).reduce(
    (n, items) => n + items.length,
    0,
  );
  return { ...sections, totalProblems };
};

// Per-detector item types — the canonical shapes the problems repo's find*
// functions return, inferred from the schemas above so the repo never restates
// them. `coverage.covered` carries the BaseKind union natively (via baseKind).
export type DuplicateUniqueProduct = z.infer<
  typeof duplicateUniqueProductSchema
>;
export type OrphanedProduct = z.infer<typeof orphanedProductSchema>;
export type ProductWithoutMappings = z.infer<
  typeof productWithoutMappingsSchema
>;
export type IngredientWithPartialCoverage = z.infer<
  typeof ingredientWithPartialCoverageSchema
>;
export type IngredientWithoutProduct = z.infer<
  typeof ingredientWithoutProductSchema
>;
export type IngredientWithUnusedAliases = z.infer<
  typeof ingredientWithUnusedAliasesSchema
>;
export type UnusedIngredient = z.infer<typeof unusedIngredientSchema>;
export type EmptyLocation = z.infer<typeof emptyLocationSchema>;
export type ProductWithIslandedMappings = z.infer<
  typeof productWithIslandedMappingsSchema
>;
export type LocationWithoutAiDescription = z.infer<
  typeof locationWithoutAiDescriptionSchema
>;
export type StaleIngredientParse = z.infer<typeof staleIngredientParseSchema>;
export type ProductWithBetterUpcData = z.infer<
  typeof productWithBetterUpcDataSchema
>;

// Counts powering the Settings → Maintenance "N affected" dry-run. A focused
// subset (the batch tools shown there), kept separate from problemsCount so it
// can run only cheap DB/WASM detectors — no USDA/UPC network. Keys mirror the
// canonical `problemsCount.byType` names (a Pick of them) so the Maintenance row
// and the Problems section read the same field — no third naming convention.
export const maintenanceCountsSchema = z.object({
  productsWithNoImages: z.number().int(),
  locationsWithoutAiDescription: z.number().int(),
  // Active recipes whose persisted totals are stale (pending recompute). The
  // recompute queue normally drains these in seconds; a lingering count means a
  // wave was lost (DLQ) — recompute-all clears it.
  staleRecipeTotals: z.number().int(),
});
export type MaintenanceCounts = z.infer<typeof maintenanceCountsSchema>;

export const reparseStaleSyncOut = z.object({
  updated: z.number().int().nonnegative(),
  recipesAffected: z.number().int().nonnegative(),
});

export const dryRunReparseOut = z.object({
  wouldChange: z.number().int(),
  total: z.number().int(),
});

export const dryRunPruneAliasesOut = z.object({
  wouldPrune: z.number().int(),
  ingredients: z.number().int(),
});

export const cleanupOrphanedEntityEmbeddingsInput = z
  .object({
    ids: z.array(z.string()).optional(),
  })
  .optional();

export const cleanupOrphanedEntityEmbeddingsOut = z.object({
  found: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});

export const recipeUsageByProductInput = z.object({
  productIds: z.array(z.string()),
});

export const recipeUsageByProductOut = z.record(z.string(), z.number());

export const deleteUnusedIngredientsInput = z.object({
  ingredientIds: z.array(ingredientId),
  alsoDeleteProducts: z.boolean(),
});

export const deleteUnusedIngredientsOut = z.object({
  deleted: z.number(),
  failed: z.array(z.object({ id: ingredientId, reason: z.string() })),
});
