import type { Entity } from "@cubby/schemas/entity";
import type { SortParams } from "@cubby/schemas/pagination";
import type {
  EmptyCookedMeal,
  EmptyLocation,
  IngredientWithoutProduct,
  LocationWithoutAiDescription,
  NegativeExpectedQuantity,
  NeverVerifiedInventory,
  ProblemsViewsOut,
  ProductMissingPrice,
  ProductWithoutMappings,
  RecipeWithoutInstructions,
  SectionTotals,
  StaleLocation,
  UnusedIngredient,
} from "@cubby/schemas/problems";
import {
  type ViewProblemDeclaration,
  viewProblemDeclarations,
} from "~/entities/view-manifest";
import { type Database, withConnection } from "~/server/db";
import { ingredientList } from "~/server/repo/ingredient";
import { inventoryentryList } from "~/server/repo/inventory";
import { locationList } from "~/server/repo/location";
import { mealList } from "~/server/repo/meal";
import { productList } from "~/server/repo/product";
import { recipeList } from "~/server/repo/recipe";
import { traceAllSeq } from "~/server/tracing";

/**
 * The Problems sections that are backed by a saved view rather than a bespoke
 * detector.
 *
 * These used to be hand-written SQL that re-stated a predicate the entity's own
 * list already expressed as filters — and the schemas said so out loud
 * (`productFilterFields.expectedQuantityMax` documents `-1` as the
 * "sold or returned more than was ever bought" worklist, which a detector
 * separately re-derived with a grouped HAVING). One question, two
 * implementations, two places to drift. Now the view declaration is the only
 * statement of the predicate and this runs it through the ordinary list path.
 *
 * The rows are a SAMPLE — page one — so every count downstream must read
 * `totals`, not `rows.length`. That is what `sectionTotals` is for.
 */

/**
 * How many rows a view-backed card shows before deferring to the full list.
 * Matches `ProblemSection`'s own initial cap, so a converted card looks
 * identical to a detector-backed one at rest.
 */
const SAMPLE_SIZE = 12;

/**
 * A list function's shape, narrowed to what this module uses. Every entity list
 * repo already matches it — that's the seam this reuses rather than extracts.
 *
 * `filters` is `never` on purpose: each repo wants its own `*Filters` type and
 * they have no common supertype, so the registry below casts once at the call
 * site. The cast is safe because the pinning test in
 * `view-manifest.unit.test.tsx` parses every `serverFilters` through the real
 * manifest, and the filter guard in `filter-application.integration.test.ts`
 * proves each declared field is actually applied.
 */
type ListRow = Record<string, unknown> & { id: string };
type ListFn = (
  db: Database,
  filters: never,
  sorts: SortParams[],
  pagination: { pageIndex: number; pageSize: number },
) => Promise<{ data: ListRow[]; count: number }>;

const LIST_FN = {
  ingredient: ingredientList,
  inventory: inventoryentryList,
  location: locationList,
  meal: mealList,
  product: productList,
  recipe: recipeList,
} as unknown as Partial<Record<Entity, ListFn>>;

/** A view's `{id, desc}` sort, in the shape the repos' `buildOrderBy` wants. */
const toSortParams = (sort: ViewProblemDeclaration["sort"]): SortParams[] =>
  (sort ?? []).map(({ id, desc }) => ({
    orderBy: id,
    direction: desc ? "desc" : "asc",
  }));

/**
 * Narrow a list row to the card's contract.
 *
 * The list row is a superset, so this only drops fields — but it must be
 * explicit rather than a `schema.parse()`, because `strictOutput` rejects extra
 * keys and several of these fields (`amount`) are codecs that don't round-trip
 * through their own output. One entry per converted key; the compiler holds it
 * to the schema's shape.
 */
const toNeverVerified = (row: ListRow): NeverVerifiedInventory => {
  const r = row as unknown as NeverVerifiedInventory;
  return {
    id: r.id,
    amount: r.amount,
    createdAt: r.createdAt,
    product: { id: r.product.id, name: r.product.name },
    location: { id: r.location.id, name: r.location.name },
  };
};

const toUnusedIngredient = (row: ListRow): UnusedIngredient => {
  const r = row as unknown as UnusedIngredient & {
    product: { id: UnusedIngredient["products"][number]["id"]; name: string }[];
  };
  return {
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    // The list embeds the full product rows; the card only names them.
    products: r.product.map((p) => ({ id: p.id, name: p.name })),
  };
};

const toLocationWithoutAiDescription = (
  row: ListRow,
): LocationWithoutAiDescription => {
  const r = row as unknown as LocationWithoutAiDescription & {
    images: unknown[];
  };
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    // The list's `images` relation is soft-delete guarded, which the detector's
    // raw `innerJoin(locationImage)` was not — so this no longer counts
    // detached associations. It carries no content-type filter, so a PDF
    // attachment still counts, exactly as before.
    imageCount: r.images.length,
  };
};

const toEmptyLocation = (row: ListRow): EmptyLocation => {
  const r = row as unknown as EmptyLocation & {
    images: { id: string; url: string }[];
  };
  // The detector built these two with a pair of correlated subqueries ordered
  // by LocationImage.createdAt; the list's `images` relation is `imageOrder`-
  // first, so this is the cover rather than the oldest. Display-only — the card
  // shows a thumbnail, and every count comes from `sectionTotals`.
  const cover = r.images[0];
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    createdAt: r.createdAt,
    lastBulkInventory: r.lastBulkInventory,
    aiDescription: r.aiDescription,
    firstImageUrl: cover?.url ?? null,
    firstImageId: cover?.id ?? null,
  };
};

const toNegativeExpectedQuantity = (row: ListRow): NegativeExpectedQuantity => {
  const r = row as unknown as {
    id: NegativeExpectedQuantity["id"];
    name: string;
    manufacturer: string;
    // Field-for-field the five numbers the detector used to compute itself.
    quantityLedger: Omit<
      NegativeExpectedQuantity,
      "id" | "name" | "manufacturer"
    >;
  };
  return {
    id: r.id,
    name: r.name,
    manufacturer: r.manufacturer,
    ...r.quantityLedger,
  };
};

const toEmptyCookedMeal = (row: ListRow): EmptyCookedMeal => {
  const r = row as unknown as EmptyCookedMeal;
  return { id: r.id, name: r.name, date: r.date };
};

const toProductMissingPrice = (row: ListRow): ProductMissingPrice => {
  const r = row as unknown as ProductMissingPrice & {
    inventoryEntry: {
      amount: { value: number };
      location: {
        id: ProductMissingPrice["locations"][number]["id"];
        name: string;
      };
    }[];
  };
  return {
    id: r.id,
    name: r.name,
    manufacturer: r.manufacturer,
    // A blind sum across entries, matching the detector — deliberately NOT
    // `onHandUnits`, which returns null when a product's entries carry more
    // than one unit. Here the number is a rough "how much is sitting unpriced",
    // and a null would read as "none" rather than "mixed".
    inventoryQuantity: r.inventoryEntry.reduce((n, e) => n + e.amount.value, 0),
    // One per ENTRY, not deduped by location — same as the detector, so a
    // product on two shelves names both.
    locations: r.inventoryEntry.map((e) => ({
      id: e.location.id,
      name: e.location.name,
    })),
  };
};

const toProductWithoutMappings = (row: ListRow): ProductWithoutMappings => {
  const r = row as unknown as ProductWithoutMappings & {
    ingredient: { id: ProductWithoutMappings["ingredientId"] } | null;
    usdaUnavailable: boolean | null;
  };
  return {
    id: r.id,
    name: r.name,
    manufacturer: r.manufacturer,
    createdAt: r.createdAt,
    // The detector read `isIngredient` off the raw FK but `ingredientId` off a
    // soft-delete-guarded join, so a product whose ingredient was deleted came
    // back `{isIngredient: true, ingredientId: null}`. The list embed is
    // guarded, so both now agree — the honest reading, since a deleted
    // ingredient is no link at all.
    isIngredient: r.ingredient != null,
    ingredientId: r.ingredient?.id ?? null,
    usdaUnavailable: r.usdaUnavailable ?? false,
  };
};

const toStaleLocation = (row: ListRow): StaleLocation => {
  const r = row as unknown as StaleLocation & {
    inventoryEntries: unknown[];
  };
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    lastBulkInventory: r.lastBulkInventory,
    // The list embeds the live entries the count filter selected on, so this is
    // the same population `directItemCountMin` measured.
    itemCount: r.inventoryEntries.length,
  };
};

const toRecipeWithoutInstructions = (
  row: ListRow,
): RecipeWithoutInstructions => {
  const r = row as unknown as RecipeWithoutInstructions;
  return { id: r.id, name: r.name, sectionCount: r.sectionCount };
};

const toIngredientWithoutProduct = (row: ListRow): IngredientWithoutProduct => {
  const r = row as unknown as IngredientWithoutProduct & {
    ownRecipeCount: number;
  };
  return {
    id: r.id,
    name: r.name,
    // `ownRecipeCount`, not `appearsInRecipes.length` — the same non-cookbook
    // population the filter selected on, so the card's number and the list it
    // links to can't disagree.
    recipeCount: r.ownRecipeCount,
  };
};

export const findViewProblems = async (
  db: Database,
): Promise<ProblemsViewsOut> => {
  const declarations = viewProblemDeclarations();

  // Same discipline as `findFastProblems`: pin every query to ONE connection
  // and run them sequentially. A pg client takes one query at a time, so
  // fanning these out would only make N connections contend for the max:5 pool
  // without overlapping any work. `withConnection` hands back a branded
  // `Database`, which is exactly what every list fn already takes — so this
  // needs no repo changes at all.
  //
  // NOTE: nothing in here may itself call `withConnection`. The scoped Database
  // carries no `$client` pool, so a nested acquire would throw. No list fn does
  // today; this comment is the reason to keep it that way.
  const results = await withConnection(db, (scoped) =>
    traceAllSeq(
      Object.fromEntries(
        declarations.map((declaration) => [
          declaration.problem.key,
          async () => {
            const list = LIST_FN[declaration.entity];
            if (!list) {
              throw new Error(
                `No list function registered for entity "${declaration.entity}" (view "${declaration.viewId}")`,
              );
            }
            return list(
              scoped,
              declaration.problem.serverFilters as never,
              toSortParams(declaration.sort),
              { pageIndex: 0, pageSize: SAMPLE_SIZE },
            );
          },
        ]),
      ),
    ),
  );

  // The counts are what the badge, `totalProblems`, and the coverage meters
  // read. `executeListQueryWithCount` computes each as its own `countWhere`
  // alongside the page, so they are exact regardless of SAMPLE_SIZE.
  const sectionTotals: SectionTotals = {};
  for (const { problem } of declarations) {
    sectionTotals[problem.key] = results[problem.key]?.count ?? 0;
  }

  return {
    neverVerifiedInventory: (results.neverVerifiedInventory?.data ?? []).map(
      toNeverVerified,
    ),
    unusedIngredientsWithProduct: (
      results.unusedIngredientsWithProduct?.data ?? []
    ).map(toUnusedIngredient),
    unusedIngredientsWithoutProduct: (
      results.unusedIngredientsWithoutProduct?.data ?? []
    ).map(toUnusedIngredient),
    locationsWithoutAiDescription: (
      results.locationsWithoutAiDescription?.data ?? []
    ).map(toLocationWithoutAiDescription),
    emptyLocations: (results.emptyLocations?.data ?? []).map(toEmptyLocation),
    negativeExpectedQuantity: (
      results.negativeExpectedQuantity?.data ?? []
    ).map(toNegativeExpectedQuantity),
    emptyCookedMeals: (results.emptyCookedMeals?.data ?? []).map(
      toEmptyCookedMeal,
    ),
    productsMissingPrice: (results.productsMissingPrice?.data ?? []).map(
      toProductMissingPrice,
    ),
    unvaluedBucketProducts: (results.unvaluedBucketProducts?.data ?? []).map(
      toProductMissingPrice,
    ),
    productsWithoutMappings: (results.productsWithoutMappings?.data ?? []).map(
      toProductWithoutMappings,
    ),
    staleLocations: (results.staleLocations?.data ?? []).map(toStaleLocation),
    recipesWithoutInstructions: (
      results.recipesWithoutInstructions?.data ?? []
    ).map(toRecipeWithoutInstructions),
    ingredientsWithoutProduct: (
      results.ingredientsWithoutProduct?.data ?? []
    ).map(toIngredientWithoutProduct),
    sectionTotals,
  };
};

/**
 * Every shortcode a view-backed section selects — the whole set, not the page
 * its card renders.
 *
 * Exists so a bulk action ("Delete all") can mean all. The card is handed
 * SAMPLE_SIZE rows, so wiring a bulk mutation to what it rendered would act on
 * twelve and say all; re-running the view's own filters here keeps membership
 * on the server, where it belongs.
 */
export const findAllViewProblemIds = async (
  db: Database,
  key: string,
): Promise<string[]> => {
  const declaration = viewProblemDeclarations().find(
    (candidate) => candidate.problem.key === key,
  );
  if (!declaration) throw new Error(`No view declares problem "${key}"`);
  const list = LIST_FN[declaration.entity];
  if (!list) {
    throw new Error(
      `No list function registered for entity "${declaration.entity}"`,
    );
  }

  // Paged rather than one huge fetch: these sections converge to zero, so the
  // loop almost always runs once, and it can't be defeated by a population that
  // outgrows a hand-picked ceiling.
  const PAGE = 500;
  const ids: string[] = [];
  for (let pageIndex = 0; ; pageIndex++) {
    const { data, count } = await list(
      db,
      declaration.problem.serverFilters as never,
      [],
      { pageIndex, pageSize: PAGE },
    );
    ids.push(...data.map((row) => row.id));
    if (data.length === 0 || ids.length >= count) return ids;
  }
};

/**
 * How many rows a view-backed section selects, without fetching any of them.
 *
 * For callers that only ever render a number — the Settings → Maintenance card
 * — so they don't pay for a page of relation-embedded rows to call `.length` on
 * it. `executeListQueryWithCount` runs the count as its own query, so a
 * `pageSize: 1` page is nearly free.
 */
export const countViewProblem = async (
  db: Database,
  key: string,
): Promise<number> => {
  const declaration = viewProblemDeclarations().find(
    (candidate) => candidate.problem.key === key,
  );
  if (!declaration) throw new Error(`No view declares problem "${key}"`);
  const list = LIST_FN[declaration.entity];
  if (!list) {
    throw new Error(
      `No list function registered for entity "${declaration.entity}"`,
    );
  }
  const { count } = await list(
    db,
    declaration.problem.serverFilters as never,
    [],
    { pageIndex: 0, pageSize: 1 },
  );
  return count;
};
