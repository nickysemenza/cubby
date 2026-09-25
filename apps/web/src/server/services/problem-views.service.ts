import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { imageListFiltersSchema } from "@cubby/schemas/image";
import type { SortParams } from "@cubby/schemas/pagination";
import type {
  ProblemKey,
  ProblemsViewsOut,
  SectionTotals,
  ProblemItem,
} from "@cubby/schemas/problems";
import {
  emptyLocationSchema,
  ingredientWithoutProductSchema,
  locationWithoutAiDescriptionSchema,
  negativeExpectedQuantitySchema,
  neverVerifiedInventorySchema,
  productMissingPriceSchema,
  productWithoutMappingsSchema,
  staleLocationSchema,
  unusedIngredientSchema,
} from "@cubby/schemas/problems";
import { z } from "zod";

import {
  parseEntityListInput,
  type ListEntity,
} from "~/entities/generated/entity-lists.gen";
import { compileProblemFilters } from "~/entities/problem-filter-semantics";
import type {
  DiagnosticKey,
  EntityProblemSource,
  FilterAssembly,
  ProblemFreshness,
  ProblemSource,
} from "~/entities/problem-query";
import {
  problemQuery,
  problemQueryDeclarations,
} from "~/entities/problem-registry";
import { validateCompleteProblemRegistry } from "~/entities/problem-registry-validation";
import {
  type ViewProblemDeclaration,
  viewProblemDeclarations,
} from "~/entities/view-manifest";
import type { Database } from "~/server/db";
import { expenseList } from "~/server/repo/expense";
import { listFinancialTransactions } from "~/server/repo/financial-transaction";
import { imageList } from "~/server/repo/image";
import { ingredientList } from "~/server/repo/ingredient";
import { inventoryentryList } from "~/server/repo/inventory";
import { locationList } from "~/server/repo/location";
import { mealList } from "~/server/repo/meal";
import { productList } from "~/server/repo/product";
import {
  getProductConversionCoverageFreshness,
  type ProductConversionCoverageFreshness,
} from "~/server/repo/product/conversion-coverage";
import { projectList } from "~/server/repo/project";
import { purchaseList } from "~/server/repo/purchase";
import { recipeList } from "~/server/repo/recipe";
import { taskList } from "~/server/repo/task";
import { vendorList } from "~/server/repo/vendor";
import {
  type DiagnosticRunOptions,
  diagnosticAdapters,
  runDiagnostic,
} from "~/server/services/problem-diagnostics.service";
import { traceAllBounded } from "~/server/tracing";

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

const SAMPLE_SIZE = 12;

/**
 * Server adapters for the Problem read seam. The declaration registry remains
 * data-only; these wrappers localize each repo's concrete filter type and the
 * product/location groupBy parameter instead of erasing thirteen incompatible
 * functions into one cast.
 */
type ListRow = { id: string };
type EntityReadKind = "sample" | "count";
type EntityReadAdapter = {
  read: (
    db: Database,
    filters: FilterAssembly,
    sorts: SortParams[],
    pagination: { pageIndex: number; pageSize: number },
    kind: EntityReadKind,
  ) => Promise<{ data: ListRow[]; count: number }>;
  ids?: (
    db: Database,
    filters: FilterAssembly,
    sorts: SortParams[],
    pagination: { pageIndex: number; pageSize: number },
  ) => Promise<{ ids: string[]; hasMore: boolean }>;
};

const parsedFiltersFor = <E extends ListEntity>(
  entity: E,
  filters: FilterAssembly,
) =>
  parseEntityListInput(entity, {
    entity,
    filters: compileProblemFilters(entity, filters),
  }).filters;

const ENTITY_READERS = {
  expense: {
    read: (db, filters, sorts, pagination, kind) =>
      expenseList(
        db,
        parsedFiltersFor("expense", filters),
        sorts,
        pagination,
        kind,
      ),
  },
  financialTransaction: {
    read: (db, filters, sorts, pagination, kind) =>
      listFinancialTransactions(
        db,
        parsedFiltersFor("financialTransaction", filters),
        sorts,
        pagination,
        kind,
      ),
  },
  image: {
    read: (db, filters, sorts, pagination, kind) =>
      imageList(
        db,
        imageListFiltersSchema.parse(compileProblemFilters("image", filters)),
        sorts,
        pagination,
        kind,
      ),
  },
  ingredient: {
    read: (db, filters, sorts, pagination, kind) =>
      ingredientList(
        db,
        parsedFiltersFor("ingredient", filters),
        sorts,
        pagination,
        kind,
      ),
    ids: async (db, filters, sorts, pagination) => {
      const result = await ingredientList(
        db,
        parsedFiltersFor("ingredient", filters),
        sorts,
        pagination,
        "ids",
      );
      return {
        ids: result.data.map((row) => row.id),
        hasMore: result.hasMore,
      };
    },
  },
  inventory: {
    read: (db, filters, sorts, pagination, kind) =>
      inventoryentryList(
        db,
        parsedFiltersFor("inventory", filters),
        sorts,
        pagination,
        kind,
      ),
  },
  location: {
    read: (db, filters, sorts, pagination, kind) =>
      locationList(
        db,
        parsedFiltersFor("location", filters),
        sorts,
        pagination,
        undefined,
        kind,
      ),
  },
  meal: {
    read: (db, filters, sorts, pagination, kind) =>
      mealList(db, parsedFiltersFor("meal", filters), sorts, pagination, kind),
  },
  product: {
    read: (db, filters, sorts, pagination, kind) =>
      productList(
        db,
        parsedFiltersFor("product", filters),
        sorts,
        pagination,
        undefined,
        kind,
      ),
  },
  project: {
    read: (db, filters, sorts, pagination, kind) =>
      projectList(
        db,
        parsedFiltersFor("project", filters),
        sorts,
        pagination,
        kind,
      ),
  },
  purchase: {
    read: (db, filters, sorts, pagination, kind) =>
      purchaseList(
        db,
        parsedFiltersFor("purchase", filters),
        sorts,
        pagination,
        kind,
      ),
  },
  recipe: {
    read: (db, filters, sorts, pagination, kind) =>
      recipeList(
        db,
        parsedFiltersFor("recipe", filters),
        sorts,
        pagination,
        kind,
      ),
  },
  task: {
    read: (db, filters, sorts, pagination, kind) =>
      taskList(db, parsedFiltersFor("task", filters), sorts, pagination, kind),
  },
  vendor: {
    read: (db, filters, sorts, pagination, kind) =>
      vendorList(
        db,
        parsedFiltersFor("vendor", filters),
        sorts,
        pagination,
        kind,
      ),
  },
} satisfies Partial<Record<Entity, EntityReadAdapter>>;

type ReaderEntity = keyof typeof ENTITY_READERS;
const isReaderEntity = (value: string): value is ReaderEntity =>
  entitySchema.safeParse(value).success && Object.hasOwn(ENTITY_READERS, value);
const entityReaderFor = (entity: Entity): EntityReadAdapter | undefined =>
  isReaderEntity(entity) ? ENTITY_READERS[entity] : undefined;

const isDiagnosticKey = (value: string): value is DiagnosticKey =>
  Object.hasOwn(diagnosticAdapters, value);

validateCompleteProblemRegistry(problemQueryDeclarations(), {
  listEntities: new Set(Object.keys(ENTITY_READERS).filter(isReaderEntity)),
  diagnostics: new Set(Object.keys(diagnosticAdapters).filter(isDiagnosticKey)),
});

const toSortParams = (
  sort: readonly { id: string; desc: boolean }[] | undefined,
): SortParams[] =>
  (sort ?? []).map(({ id, desc }) => ({
    orderBy: id,
    direction: desc ? "desc" : "asc",
  }));

const entityFiltersFor = (
  declaration: ViewProblemDeclaration,
): FilterAssembly => {
  const source = declaration.problem.source;
  if (source.kind !== "entity") {
    throw new Error(
      `View problem "${declaration.problem.key}" is not entity-backed`,
    );
  }
  return source.filters;
};

const entityProblemForKey = (key: ProblemKey): EntityProblemSource => {
  const definition = problemQuery(key);
  if (definition?.source.kind !== "entity") {
    throw new Error(`No entity Problem declares "${key}"`);
  }
  return definition.source;
};

/**
 * Execute one registered entity-grain Problem.  The result is deliberately
 * the list contract (exact count plus a page) so callers cannot accidentally
 * derive a total from the card sample.
 */
type ProblemRunStatus =
  | { state: "healthy" }
  | {
      state: "stale";
      message: string;
      projection?: ProductConversionCoverageFreshness;
    }
  | {
      state: "unavailable";
      message: string;
      projection?: ProductConversionCoverageFreshness;
    };

export type ProblemRunResult = {
  data: ListRow[];
  items: readonly unknown[];
  count: number;
  source: ProblemSource;
  status: ProblemRunStatus;
  freshness?: Awaited<ReturnType<typeof runDiagnostic>>["freshness"];
};

const statusForFreshness = (freshness: ProblemFreshness): ProblemRunStatus =>
  freshness.kind === "external"
    ? {
        state: "stale",
        message: `${freshness.provider} freshness is supplied by its diagnostic adapter.`,
      }
    : { state: "healthy" };

const statusForProjection = (
  freshness: ProductConversionCoverageFreshness,
): ProblemRunStatus => {
  if (freshness.state === "fresh") return { state: "healthy" };
  const missing = freshness.missingCount + freshness.staleCount;
  return freshness.state === "unavailable"
    ? {
        state: "unavailable",
        message: `${freshness.unavailableCount} conversion projection row${freshness.unavailableCount === 1 ? " is" : "s are"} unavailable; exact filters fail closed until enrichment recovers.`,
        projection: freshness,
      }
    : {
        state: "stale",
        message: `${missing} conversion projection row${missing === 1 ? " is" : "s are"} stale or missing; exact filters fail closed until the projection is rebuilt.`,
        projection: freshness,
      };
};

const usesConversionCoverageProjection = (key: ProblemKey): boolean =>
  key === "ingredientsWithPartialCoverage" ||
  key === "productsWithIslandedMappings";

/** The same registered card projection is used by grouped and single-type reads. */
const presentProblemRows = (
  key: ProblemKey,
  rows: ListRow[],
): readonly unknown[] => {
  switch (key) {
    case "neverVerifiedInventory":
      return rows.map(toNeverVerified);
    case "unusedIngredientsWithProduct":
    case "unusedIngredientsWithoutProduct":
      return rows.map(toUnusedIngredient);
    case "locationsWithoutAiDescription":
      return rows.map(toLocationWithoutAiDescription);
    case "emptyLocations":
      return rows.map(toEmptyLocation);
    case "negativeExpectedQuantity":
      return rows.map(toNegativeExpectedQuantity);
    case "productsMissingPrice":
    case "unvaluedBucketProducts":
      return rows.map(toProductMissingPrice);
    case "productsWithoutMappings":
      return rows.map(toProductWithoutMappings);
    case "staleLocations":
      return rows.map(toStaleLocation);
    case "ingredientsWithoutProduct":
      return rows.map(toIngredientWithoutProduct);
    default:
      return rows;
  }
};

/**
 * Run a registered Problem through its one canonical source declaration.
 * Entity membership compiles to the ordinary list path; derived membership is
 * delegated only by typed DiagnosticKey, never a callback in the manifest.
 */
export const executeProblem = async (
  db: Database,
  key: ProblemKey,
  options: {
    mode?: "sample" | "count";
    pageIndex?: number;
    sampleSize?: number;
    diagnostic?: DiagnosticRunOptions;
    projectionFreshness?: ProductConversionCoverageFreshness;
  } = {},
): Promise<ProblemRunResult> => {
  const definition = problemQuery(key);
  if (!definition) throw new Error(`No registered Problem declares "${key}"`);
  if (definition.source.kind === "derived") {
    const offset =
      (options.pageIndex ?? 0) * (options.sampleSize ?? SAMPLE_SIZE);
    const diagnostic =
      options.mode === "count"
        ? await runDiagnostic(
            db,
            definition.source.diagnostic,
            options.diagnostic ?? {},
            { kind: "count" },
          )
        : await runDiagnostic(
            db,
            definition.source.diagnostic,
            options.diagnostic,
            {
              kind: "sample",
              limit: offset + (options.sampleSize ?? SAMPLE_SIZE),
            },
          );
    const items =
      "items" in diagnostic && Array.isArray(diagnostic.items)
        ? diagnostic.items.slice(
            offset,
            offset + (options.sampleSize ?? SAMPLE_SIZE),
          )
        : [];
    return {
      // Derived rows intentionally have no common list row contract. Keeping
      // this empty prevents entity presenters from treating a pair/group as an
      // entity; consumers use `items` and the declared grain instead.
      data: [],
      items,
      count: diagnostic.count,
      source: definition.source,
      status: diagnostic.status,
      freshness: diagnostic.freshness,
    };
  }
  const source = definition.source;
  const reader = entityReaderFor(source.entity);
  if (!reader) {
    throw new Error(
      `No list function registered for entity "${source.entity}"`,
    );
  }
  const page = await reader.read(
    db,
    source.filters,
    toSortParams(source.sort),
    {
      pageIndex: options.pageIndex ?? 0,
      pageSize: options.sampleSize ?? SAMPLE_SIZE,
    },
    options.mode === "count" ? "count" : "sample",
  );
  const projection =
    options.mode !== "count" && usesConversionCoverageProjection(key)
      ? (options.projectionFreshness ??
        (await getProductConversionCoverageFreshness(db)))
      : undefined;
  return {
    ...page,
    items: presentProblemRows(key, page.data),
    source,
    status: projection
      ? statusForProjection(projection)
      : statusForFreshness(definition.freshness),
  };
};

/**
 * Narrow a list row to the card's contract.
 *
 * The list row is a superset, so this only drops fields — but it must be
 * explicit rather than a `schema.parse()`, because `strictOutput` rejects extra
 * keys and several of these fields (`amount`) are codecs that don't round-trip
 * through their own output. One entry per converted key; the compiler holds it
 * to the schema's shape.
 */
const toNeverVerified = (
  row: ListRow,
): ProblemItem<"neverVerifiedInventory"> => {
  const r = neverVerifiedInventorySchema.parse(row);
  return {
    id: r.id,
    amount: r.amount,
    createdAt: r.createdAt,
    product: { id: r.product.id, name: r.product.name },
    location: { id: r.location.id, name: r.location.name },
  };
};

const toUnusedIngredient = (
  row: ListRow,
): ProblemItem<"unusedIngredientsWithProduct"> => {
  const r = unusedIngredientSchema
    .omit({ products: true })
    .extend({
      product: z.array(
        z.object({
          id: unusedIngredientSchema.shape.products.element.shape.id,
          name: z.string(),
        }),
      ),
    })
    .parse(row);
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
): ProblemItem<"locationsWithoutAiDescription"> => {
  const r = locationWithoutAiDescriptionSchema
    .omit({ imageCount: true })
    .extend({ images: z.array(z.unknown()) })
    .parse(row);
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

const toEmptyLocation = (row: ListRow): ProblemItem<"emptyLocations"> => {
  const r = emptyLocationSchema
    .omit({ firstImageId: true, firstImageUrl: true })
    .extend({ images: z.array(z.object({ id: z.string(), url: z.string() })) })
    .parse(row);
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

const toNegativeExpectedQuantity = (
  row: ListRow,
): ProblemItem<"negativeExpectedQuantity"> => {
  const r = z
    .object({
      id: negativeExpectedQuantitySchema.shape.id,
      name: z.string(),
      manufacturer: z.string(),
      quantityLedger: negativeExpectedQuantitySchema.omit({
        id: true,
        name: true,
        manufacturer: true,
      }),
    })
    .parse(row);
  return {
    id: r.id,
    name: r.name,
    manufacturer: r.manufacturer,
    ...r.quantityLedger,
  };
};

const toProductMissingPrice = (
  row: ListRow,
): ProblemItem<"productsMissingPrice"> => {
  const r = productMissingPriceSchema
    .omit({ inventoryQuantity: true, locations: true })
    .extend({
      inventoryEntry: z.array(
        z.object({
          amount: z.object({ value: z.number() }),
          location: z.object({
            id: productMissingPriceSchema.shape.locations.element.shape.id,
            name: z.string(),
          }),
        }),
      ),
    })
    .parse(row);
  return {
    id: r.id,
    name: r.name,
    manufacturer: r.manufacturer,
    inventoryQuantity: r.inventoryEntry.reduce((n, e) => n + e.amount.value, 0),
    locations: r.inventoryEntry.map((e) => ({
      id: e.location.id,
      name: e.location.name,
    })),
  };
};

const toProductWithoutMappings = (
  row: ListRow,
): ProblemItem<"productsWithoutMappings"> => {
  const r = productWithoutMappingsSchema
    .omit({ isIngredient: true, ingredientId: true, usdaUnavailable: true })
    .extend({
      ingredient: z
        .object({
          id: productWithoutMappingsSchema.shape.ingredientId.unwrap(),
        })
        .nullable(),
      usdaUnavailable: z.boolean().nullable(),
    })
    .parse(row);
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

const toStaleLocation = (row: ListRow): ProblemItem<"staleLocations"> => {
  const r = staleLocationSchema
    .omit({ itemCount: true })
    .extend({ inventoryEntries: z.array(z.unknown()) })
    .parse(row);
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

const toIngredientWithoutProduct = (
  row: ListRow,
): ProblemItem<"ingredientsWithoutProduct"> => {
  const r = ingredientWithoutProductSchema
    .omit({ recipeCount: true })
    .extend({ ownRecipeCount: z.number() })
    .parse(row);
  return {
    id: r.id,
    name: r.name,
    // `ownRecipeCount`, not `appearsInRecipes.length` — the same non-cookbook
    // population the filter selected on, so the card's number and the list it
    // links to can't disagree.
    recipeCount: r.ownRecipeCount,
  };
};

type ViewProblemResults = Record<
  string,
  { data: ListRow[]; count: number } | undefined
>;

const projectViewProblemRows = <T>(
  results: ViewProblemResults,
  key: string,
  presenter: (row: ListRow) => T,
): T[] => (results[key]?.data ?? []).map(presenter);

const viewProblemSectionTotals = (
  declarations: ViewProblemDeclaration[],
  results: ViewProblemResults,
): SectionTotals => {
  const totals: SectionTotals = {};
  for (const { problem } of declarations) {
    totals[problem.key] = results[problem.key]?.count ?? 0;
  }
  return totals;
};

export const findViewProblems = async (
  db: Database,
): Promise<ProblemsViewsOut> => {
  const declarations = viewProblemDeclarations();

  const results = await traceAllBounded(
    Object.fromEntries(
      declarations.map((declaration) => [
        declaration.problem.key,
        async () => {
          const reader = entityReaderFor(declaration.entity);
          if (!reader) {
            throw new Error(
              `No list function registered for entity "${declaration.entity}" (view "${declaration.viewId}")`,
            );
          }
          return reader.read(
            db,
            entityFiltersFor(declaration),
            toSortParams(declaration.sort),
            {
              pageIndex: 0,
              pageSize: SAMPLE_SIZE,
            },
            "sample",
          );
        },
      ]),
    ),
    4,
  );

  const sectionTotals = viewProblemSectionTotals(declarations, results);

  return {
    neverVerifiedInventory: projectViewProblemRows(
      results,
      "neverVerifiedInventory",
      toNeverVerified,
    ),
    unusedIngredientsWithProduct: projectViewProblemRows(
      results,
      "unusedIngredientsWithProduct",
      toUnusedIngredient,
    ),
    unusedIngredientsWithoutProduct: projectViewProblemRows(
      results,
      "unusedIngredientsWithoutProduct",
      toUnusedIngredient,
    ),
    locationsWithoutAiDescription: projectViewProblemRows(
      results,
      "locationsWithoutAiDescription",
      toLocationWithoutAiDescription,
    ),
    emptyLocations: projectViewProblemRows(
      results,
      "emptyLocations",
      toEmptyLocation,
    ),
    negativeExpectedQuantity: projectViewProblemRows(
      results,
      "negativeExpectedQuantity",
      toNegativeExpectedQuantity,
    ),
    productsMissingPrice: projectViewProblemRows(
      results,
      "productsMissingPrice",
      toProductMissingPrice,
    ),
    unvaluedBucketProducts: projectViewProblemRows(
      results,
      "unvaluedBucketProducts",
      toProductMissingPrice,
    ),
    productsWithoutMappings: projectViewProblemRows(
      results,
      "productsWithoutMappings",
      toProductWithoutMappings,
    ),
    staleLocations: projectViewProblemRows(
      results,
      "staleLocations",
      toStaleLocation,
    ),
    ingredientsWithoutProduct: projectViewProblemRows(
      results,
      "ingredientsWithoutProduct",
      toIngredientWithoutProduct,
    ),
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
  key: ProblemKey,
): Promise<string[]> => {
  const source = entityProblemForKey(key);
  const reader = entityReaderFor(source.entity);
  if (!reader) {
    throw new Error(
      `No list function registered for entity "${source.entity}"`,
    );
  }
  if (!reader.ids) {
    throw new Error(
      `Entity "${source.entity}" has no identity projection for Problem "${key}"`,
    );
  }

  // Paged rather than one huge fetch: these sections converge to zero, so the
  // loop almost always runs once, and it can't be defeated by a population that
  // outgrows a hand-picked ceiling.
  const PAGE = 500;
  const ids: string[] = [];
  for (let pageIndex = 0; ; pageIndex++) {
    const { ids: pageIds, hasMore } = await reader.ids(
      db,
      source.filters,
      toSortParams(source.sort),
      { pageIndex, pageSize: PAGE },
    );
    ids.push(...pageIds);
    if (!hasMore) return ids;
  }
};

/**
 * How many rows a view-backed section selects, without fetching any of them.
 *
 * For callers that only ever render a number — the Settings → Maintenance card
 * — so they don't construct or execute relation hydration or table summaries.
 */
export const countViewProblem = async (
  db: Database,
  key: ProblemKey,
): Promise<number> => {
  const source = entityProblemForKey(key);
  const reader = entityReaderFor(source.entity);
  if (!reader) {
    throw new Error(
      `No list function registered for entity "${source.entity}"`,
    );
  }
  const { count } = await reader.read(
    db,
    source.filters,
    [],
    { pageIndex: 0, pageSize: SAMPLE_SIZE },
    "count",
  );
  return count;
};
