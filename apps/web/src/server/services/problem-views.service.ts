import { amount } from "@cubby/schemas/codec";
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
  problemsViewsSchema,
  productWithoutMappingsSchema,
} from "@cubby/schemas/problems";
import { getMiscDisplayName } from "@cubby/shared";
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
import { countLabel } from "~/lib/pluralize";
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
import {
  byManufacturer,
  locationBadges,
  problemRow,
  type ProblemRowInput,
  recordBadge,
  textBadge,
} from "~/server/services/problem-rows";
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

/**
 * Narrow a list row to the card's contract. One entry per view-backed key; a
 * key without one returns the list rows unchanged.
 *
 * Each presenter parses only the fields it reads, rather than the card
 * schema, because `strictOutput` rejects extra keys and several list fields
 * (`amount`) are codecs that don't round-trip through their own output.
 */
const PROBLEM_ROW_PRESENTERS = {
  neverVerifiedInventory: (row) => toInventoryRow(row),
  unusedIngredientsWithProduct: (row) => toUnusedIngredient(row, true),
  unusedIngredientsWithoutProduct: (row) => toUnusedIngredient(row, false),
  locationsWithoutAiDescription: (row) => toLocationWithoutAiDescription(row),
  emptyLocations: (row) => toEmptyLocation(row),
  negativeExpectedQuantity: (row) => toNegativeExpectedQuantity(row),
  productsMissingPrice: (row) => toProductMissingPrice(row, false),
  unvaluedBucketProducts: (row) => toProductMissingPrice(row, true),
  productsWithoutMappings: (row) => toProductWithoutMappings(row),
  staleLocations: (row) => toStaleLocation(row),
  ingredientsWithoutProduct: (row) => toIngredientWithoutProduct(row),
} satisfies Partial<
  Record<
    ProblemKey,
    (
      row: ListRow,
    ) =>
      | ProblemRowInput
      | ProblemItem<"emptyLocations">
      | ProblemItem<"productsWithoutMappings">
  >
>;

const hasRowPresenter = (
  key: ProblemKey,
): key is keyof typeof PROBLEM_ROW_PRESENTERS =>
  Object.hasOwn(PROBLEM_ROW_PRESENTERS, key);

/** The same registered card projection is used by grouped and single-type reads. */
const presentProblemRows = (
  key: ProblemKey,
  rows: ListRow[],
): readonly unknown[] => {
  if (!hasRowPresenter(key)) return rows;
  const present = PROBLEM_ROW_PRESENTERS[key];
  return rows.map((row) => present(row));
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

const refSchema = z.object({ id: z.string(), name: z.string() });

const toInventoryRow = (row: ListRow) => {
  const r = z
    .object({ id: z.string(), amount, product: refSchema, location: refSchema })
    .parse(row);
  return problemRow(
    "inventory",
    { id: r.id, name: r.product.name },
    [`${r.amount.value} ${r.amount.unit}`],
    locationBadges([r.location]),
  );
};

const toUnusedIngredient = (row: ListRow, withProduct: boolean) => {
  const r = refSchema.extend({ product: z.array(refSchema) }).parse(row);
  return problemRow(
    "ingredient",
    r,
    // The finding is "no recipe references this", not the ingredient's age.
    ["Used in no recipes", withProduct ? null : "no product attached"],
    r.product.map((p) => recordBadge("product", p)),
  );
};

const toLocationWithoutAiDescription = (row: ListRow) => {
  const r = refSchema
    .extend({ type: z.string().nullable(), images: z.array(z.unknown()) })
    .parse(row);
  // The list's `images` relation is soft-delete guarded and carries no
  // content-type filter, so a PDF attachment still counts.
  return problemRow(
    "location",
    r,
    [`${countLabel(r.images.length, "photo")} to describe from`],
    r.type ? [textBadge(r.type)] : [],
  );
};

const toEmptyLocation = (row: ListRow): ProblemItem<"emptyLocations"> => {
  const r = emptyLocationSchema
    .omit({ firstImageId: true, firstImageUrl: true })
    .extend({ images: z.array(z.object({ id: z.string(), url: z.string() })) })
    .parse(row);
  // The list's `images` relation is `imageOrder`-first, so this is the cover.
  // Display-only — every count comes from `sectionTotals`.
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

const toNegativeExpectedQuantity = (row: ListRow) => {
  const r = refSchema
    .extend({
      manufacturer: z.string(),
      quantityLedger: z.object({
        expectedQuantity: z.number(),
        acquiredUnits: z.number(),
        exitedUnits: z.number(),
        unknownAcquisitionLines: z.number().int(),
        unknownExitLines: z.number().int(),
      }),
    })
    .parse(row);
  const ledger = r.quantityLedger;
  const unknown = ledger.unknownAcquisitionLines + ledger.unknownExitLines;
  return problemRow("product", r, [
    byManufacturer(r.manufacturer),
    `${ledger.acquiredUnits} acquired, ${ledger.exitedUnits} gone → ${ledger.expectedQuantity}`,
    unknown > 0 ? `${countLabel(unknown, "line")} carry no quantity` : null,
  ]);
};

const toProductMissingPrice = (row: ListRow, miscBucket: boolean) => {
  const r = refSchema
    .extend({
      manufacturer: z.string(),
      inventoryEntry: z.array(
        z.object({
          amount: z.object({ value: z.number() }),
          location: refSchema,
        }),
      ),
    })
    .parse(row);
  const quantity = r.inventoryEntry.reduce((n, e) => n + e.amount.value, 0);
  return problemRow(
    "product",
    { id: r.id, name: miscBucket ? getMiscDisplayName(r.name) : r.name },
    [
      byManufacturer(r.manufacturer),
      `${countLabel(quantity, "unit")} unvalued`,
    ],
    locationBadges(r.inventoryEntry.map((e) => e.location)),
  );
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
    // The list embed is soft-delete guarded, so a deleted ingredient is no link.
    isIngredient: r.ingredient != null,
    ingredientId: r.ingredient?.id ?? null,
    usdaUnavailable: r.usdaUnavailable ?? false,
  };
};

const toStaleLocation = (row: ListRow) => {
  const r = refSchema
    .extend({
      type: z.string().nullable(),
      lastBulkInventory: z.date().nullable(),
      inventoryEntries: z.array(z.unknown()),
    })
    .parse(row);
  // The recount age is the finding, so it leads. `inventoryEntries` is the
  // live population the `directItemCountMin` filter selected on.
  return problemRow(
    "location",
    r,
    [
      r.lastBulkInventory
        ? `last recounted ${r.lastBulkInventory.toISOString().slice(0, 10)}`
        : "never recounted",
    ],
    [
      ...(r.type ? [textBadge(r.type)] : []),
      textBadge(countLabel(r.inventoryEntries.length, "item")),
    ],
  );
};

const toIngredientWithoutProduct = (row: ListRow) => {
  const r = refSchema.extend({ ownRecipeCount: z.number() }).parse(row);
  // `ownRecipeCount`, not `appearsInRecipes.length` — the same non-cookbook
  // population the filter selected on.
  return problemRow("ingredient", r, [
    `Used in ${countLabel(r.ownRecipeCount, "recipe")}`,
    "no product to price it",
  ]);
};

type ViewProblemResults = Record<
  string,
  { data: ListRow[]; count: number } | undefined
>;

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

  return problemsViewsSchema.parse({
    ...Object.fromEntries(
      declarations.map(({ problem }) => [
        problem.key,
        presentProblemRows(problem.key, results[problem.key]?.data ?? []),
      ]),
    ),
    sectionTotals: viewProblemSectionTotals(declarations, results),
  });
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
