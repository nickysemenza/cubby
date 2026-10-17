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
import { countLabel } from "@cubby/shared/pluralize";
import { z } from "zod";

import {
  parseEntityListInput,
  listEntities,
  type ListEntity,
} from "~/entity/generated/entity-lists.gen";
import type { ListReadRow } from "~/entity/model/list-read-fields";
import { selectListReadRows } from "~/entity/model/list-read-schema";
import {
  type ViewProblemDeclaration,
  viewProblemDeclarations,
} from "~/entity/model/view-manifest";
import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import type {
  DiagnosticKey,
  EntityProblemSource,
  FilterAssembly,
  ProblemFreshness,
} from "~/entity/problems/problem-query";
import {
  problemQuery,
  problemQueryDeclarations,
} from "~/entity/problems/problem-registry";
import { validateCompleteProblemRegistry } from "~/entity/problems/problem-registry-validation";
import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  expenseList,
  expenseListRead,
} from "~/server/domains/expense/repo/lookup";
import {
  listFinancialTransactions,
  listFinancialTransactionsRead,
} from "~/server/domains/financial-transaction/repo/financial-transaction";
import { imageList, imageListRead } from "~/server/domains/image/repo/image";
import {
  ingredientList,
  ingredientListRead,
} from "~/server/domains/ingredient/repo/search";
import {
  inventoryentryList,
  inventoryentryListRead,
} from "~/server/domains/inventory/repo/crud";
import {
  locationList,
  locationListRead,
} from "~/server/domains/location/repo/crud";
import { mealList, mealListRead } from "~/server/domains/meal/repo/crud";
import {
  getProductConversionCoverageFreshness,
  type ProductConversionCoverageFreshness,
} from "~/server/domains/product/repo/conversion-coverage";
import {
  productList,
  listProductsRead,
} from "~/server/domains/product/repo/crud";
import {
  projectList,
  projectListRead,
} from "~/server/domains/project/repo/lookup";
import {
  purchaseList,
  purchaseListRead,
} from "~/server/domains/purchase/repo/purchase";
import { recipeList } from "~/server/domains/recipe/repo/crud";
import { taskList, taskListRead } from "~/server/domains/task/repo/lookup";
import {
  vendorList,
  vendorListRead,
} from "~/server/domains/vendor/repo/vendor";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import {
  type DiagnosticRunOptions,
  diagnosticAdapters,
} from "~/server/generic/problems/service/problem-diagnostics.service";
import {
  executeProblem,
  PROBLEM_SAMPLE_SIZE as SAMPLE_SIZE,
  type ListRow,
  type ProblemRunOptions,
  type ProblemRunResult,
  type ProblemRunStatus,
} from "~/server/generic/problems/service/problem-execution.service";
import {
  byManufacturer,
  locationBadges,
  problemRow,
  type ProblemRowInput,
  recordBadge,
  selectedProblemCard,
  textBadge,
} from "~/server/generic/problems/service/problem-rows";
import { traceAllBounded } from "~/server/observability/tracing";

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
 * Server adapters for the Problem read seam. The declaration registry remains
 * data-only; these wrappers localize each repo's concrete filter type instead
 * of erasing thirteen incompatible functions into one cast.
 */
type EntityReadKind = "sample" | "count";
type EntityReadAdapter = {
  selected?: (
    db: Database,
    filters: FilterAssembly,
    sorts: SortParams[],
    pagination: { pageIndex: number; pageSize: number },
    projection: Extract<ListProjection, { kind: "selected" }>,
    prepared?: DiagnosticRunOptions,
  ) => Promise<{ data: ListReadRow[]; count: number }>;
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
    selected: (db, filters, sorts, pagination, projection) =>
      expenseListRead(
        db,
        parsedFiltersFor("expense", filters),
        sorts,
        pagination,
        projection,
        "sample",
      ),
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
    selected: (db, filters, sorts, pagination, projection) =>
      listFinancialTransactionsRead(
        db,
        parsedFiltersFor("financialTransaction", filters),
        sorts,
        pagination,
        "sample",
        projection,
      ),
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
    selected: (db, filters, sorts, pagination, projection) =>
      imageListRead(
        db,
        imageListFiltersSchema.parse(compileProblemFilters("image", filters)),
        sorts,
        pagination,
        projection,
      ),
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
    selected: (db, filters, sorts, pagination, projection) =>
      ingredientListRead(
        db,
        parsedFiltersFor("ingredient", filters),
        sorts,
        pagination,
        projection,
      ),
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
    selected: (db, filters, sorts, pagination, projection) =>
      inventoryentryListRead(
        db,
        parsedFiltersFor("inventory", filters),
        sorts,
        pagination,
        projection,
        "sample",
      ),
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
    selected: (db, filters, sorts, pagination, projection) =>
      locationListRead(
        db,
        parsedFiltersFor("location", filters),
        sorts,
        pagination,
        projection,
        "sample",
      ),
    read: (db, filters, sorts, pagination, kind) =>
      locationList(
        db,
        parsedFiltersFor("location", filters),
        sorts,
        pagination,
        kind,
      ),
  },
  meal: {
    selected: (db, filters, sorts, pagination, projection) =>
      mealListRead(
        db,
        parsedFiltersFor("meal", filters),
        sorts,
        pagination,
        "sample",
        projection,
      ),
    read: (db, filters, sorts, pagination, kind) =>
      mealList(db, parsedFiltersFor("meal", filters), sorts, pagination, kind),
  },
  product: {
    selected: (db, filters, sorts, pagination, projection) =>
      listProductsRead(
        db,
        parsedFiltersFor("product", filters),
        sorts,
        pagination,
        "sample",
        undefined,
        projection,
      ),
    read: (db, filters, sorts, pagination, kind) =>
      productList(
        db,
        parsedFiltersFor("product", filters),
        sorts,
        pagination,
        kind,
      ),
  },
  project: {
    selected: (db, filters, sorts, pagination, projection, prepared) =>
      projectListRead(
        db,
        parsedFiltersFor("project", filters),
        sorts,
        pagination,
        projection,
        "sample",
        { attentionItems: prepared?.attentionItems },
      ),
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
    selected: (db, filters, sorts, pagination, projection) =>
      purchaseListRead(
        db,
        parsedFiltersFor("purchase", filters),
        sorts,
        pagination,
        "sample",
        projection,
      ),
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
    selected: (db, filters, sorts, pagination, projection) =>
      taskListRead(
        db,
        parsedFiltersFor("task", filters),
        sorts,
        pagination,
        projection,
        "sample",
      ),
    read: (db, filters, sorts, pagination, kind) =>
      taskList(db, parsedFiltersFor("task", filters), sorts, pagination, kind),
  },
  vendor: {
    selected: (db, filters, sorts, pagination, projection) =>
      vendorListRead(
        db,
        parsedFiltersFor("vendor", filters),
        sorts,
        pagination,
        "sample",
        projection,
      ),
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

const entityProblemForKey = (key: ProblemKey): EntityProblemSource => {
  const definition = problemQuery(key);
  if (definition?.source.kind !== "entity") {
    throw new Error(`No entity Problem declares "${key}"`);
  }
  return definition.source;
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
 * Required presenter inputs also own selected-list demand. Parse at that raw
 * row boundary rather than through strict card outputs: list codecs such as
 * `amount` do not round-trip through their own output schema.
 */
const refSchema = z.object({ id: z.string(), name: z.string() });

const inventoryCardSchema = z.object({
  id: z.string(),
  amount,
  product: refSchema,
  location: refSchema,
});

const unusedIngredientCardSchema = refSchema.extend({
  product: z.array(refSchema),
});

const locationDescriptionCardSchema = refSchema.extend({
  type: z.string().nullable(),
  images: z.array(z.unknown()),
});

const emptyLocationCardSchema = emptyLocationSchema
  .omit({ firstImageId: true, firstImageUrl: true })
  .extend({ images: z.array(z.object({ id: z.string(), url: z.string() })) });

const negativeQuantityCardSchema = refSchema.extend({
  manufacturer: z.string(),
  quantityLedger: z.object({
    expectedQuantity: z.number(),
    acquiredUnits: z.number(),
    exitedUnits: z.number(),
    unknownAcquisitionLines: z.number().int(),
    unknownExitLines: z.number().int(),
  }),
});

const missingPriceCardSchema = refSchema.extend({
  manufacturer: z.string(),
  inventoryEntry: z.array(
    z.object({
      amount: z.object({ value: z.number() }),
      location: refSchema,
    }),
  ),
});

const withoutMappingsCardSchema = productWithoutMappingsSchema
  .omit({ isIngredient: true, ingredientId: true, usdaUnavailable: true })
  .extend({
    ingredient: z
      .object({
        id: productWithoutMappingsSchema.shape.ingredientId.unwrap(),
      })
      .nullable(),
    usdaUnavailable: z.boolean().nullable(),
  });

const staleLocationCardSchema = refSchema.extend({
  type: z.string().nullable(),
  lastBulkInventory: z.date().nullable(),
  inventoryEntries: z.array(z.unknown()),
});

const ingredientWithoutProductCardSchema = refSchema.extend({
  ownRecipeCount: z.number(),
});

const PROBLEM_ROW_PRESENTERS = {
  neverVerifiedInventory: selectedProblemCard(inventoryCardSchema, (row) =>
    toInventoryRow(row),
  ),
  unusedIngredientsWithProduct: selectedProblemCard(
    unusedIngredientCardSchema,
    (row) => toUnusedIngredient(row, true),
  ),
  unusedIngredientsWithoutProduct: selectedProblemCard(
    unusedIngredientCardSchema,
    (row) => toUnusedIngredient(row, false),
  ),
  locationsWithoutAiDescription: selectedProblemCard(
    locationDescriptionCardSchema,
    (row) => toLocationWithoutAiDescription(row),
  ),
  emptyLocations: selectedProblemCard(emptyLocationCardSchema, (row) =>
    toEmptyLocation(row),
  ),
  negativeExpectedQuantity: selectedProblemCard(
    negativeQuantityCardSchema,
    (row) => toNegativeExpectedQuantity(row),
  ),
  productsMissingPrice: selectedProblemCard(missingPriceCardSchema, (row) =>
    toProductMissingPrice(row, false),
  ),
  unvaluedBucketProducts: selectedProblemCard(missingPriceCardSchema, (row) =>
    toProductMissingPrice(row, true),
  ),
  productsWithoutMappings: selectedProblemCard(
    withoutMappingsCardSchema,
    (row) => toProductWithoutMappings(row),
  ),
  staleLocations: selectedProblemCard(staleLocationCardSchema, (row) =>
    toStaleLocation(row),
  ),
  ingredientsWithoutProduct: selectedProblemCard(
    ingredientWithoutProductCardSchema,
    (row) => toIngredientWithoutProduct(row),
  ),
} satisfies Partial<
  Record<
    ProblemKey,
    {
      fields: readonly string[];
      present: (
        row: unknown,
        context: unknown,
      ) =>
        | ProblemRowInput
        | ProblemItem<"emptyLocations">
        | ProblemItem<"productsWithoutMappings">;
    }
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
  return rows.map((row) => present.present(row, undefined));
};

/**
 * Entity-backed execution uses the ordinary list reader and registered card
 * presenter; the canonical executor selects this branch before loading it.
 */
export const executeEntityProblem = async (
  db: Database,
  key: ProblemKey,
  options: ProblemRunOptions,
): Promise<ProblemRunResult> => {
  const definition = problemQuery(key);
  if (!definition) throw new Error(`No registered Problem declares "${key}"`);
  if (definition.source.kind !== "entity")
    throw new Error(`No entity Problem declares "${key}"`);
  const source = definition.source;
  const reader = entityReaderFor(source.entity);
  if (!reader) {
    throw new Error(
      `No list function registered for entity "${source.entity}"`,
    );
  }
  const pagination = {
    pageIndex: options.pageIndex ?? 0,
    pageSize: options.sampleSize ?? SAMPLE_SIZE,
  };
  const fields = options.mode === "count" ? undefined : options.fields;
  const entity = listEntities.find((entity) => entity === source.entity);
  const page = fields
    ? await (async () => {
        if (!entity || !reader.selected)
          throw new Error(
            `No selected list reader registered for ${source.entity}`,
          );
        const page = await reader.selected(
          db,
          source.filters,
          toSortParams(source.sort),
          pagination,
          selectedListProjection(entity, fields),
          options.diagnostic,
        );
        return { ...page, data: selectListReadRows(entity, page.data, fields) };
      })()
    : await reader.read(
        db,
        source.filters,
        toSortParams(source.sort),
        pagination,
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

const toInventoryRow = (r: z.output<typeof inventoryCardSchema>) => {
  return problemRow(
    "inventory",
    { id: r.id, name: r.product.name },
    [`${r.amount.value} ${r.amount.unit}`],
    locationBadges([r.location]),
  );
};

const toUnusedIngredient = (
  r: z.output<typeof unusedIngredientCardSchema>,
  withProduct: boolean,
) => {
  return problemRow(
    "ingredient",
    r,
    // The finding is "no recipe references this", not the ingredient's age.
    ["Used in no recipes", withProduct ? null : "no product attached"],
    r.product.map((p) => recordBadge("product", p)),
  );
};

const toLocationWithoutAiDescription = (
  r: z.output<typeof locationDescriptionCardSchema>,
) => {
  // The list's `images` relation is soft-delete guarded and carries no
  // content-type filter, so a PDF attachment still counts.
  return problemRow(
    "location",
    r,
    [`${countLabel(r.images.length, "photo")} to describe from`],
    r.type ? [textBadge(r.type)] : [],
  );
};

const toEmptyLocation = (
  r: z.output<typeof emptyLocationCardSchema>,
): ProblemItem<"emptyLocations"> => {
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

const toNegativeExpectedQuantity = (
  r: z.output<typeof negativeQuantityCardSchema>,
) => {
  const ledger = r.quantityLedger;
  const unknown = ledger.unknownAcquisitionLines + ledger.unknownExitLines;
  return problemRow("product", r, [
    byManufacturer(r.manufacturer),
    `${ledger.acquiredUnits} acquired, ${ledger.exitedUnits} gone → ${ledger.expectedQuantity}`,
    unknown > 0 ? `${countLabel(unknown, "line")} carry no quantity` : null,
  ]);
};

const toProductMissingPrice = (
  r: z.output<typeof missingPriceCardSchema>,
  miscBucket: boolean,
) => {
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
  r: z.output<typeof withoutMappingsCardSchema>,
): ProblemItem<"productsWithoutMappings"> => {
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

const toStaleLocation = (r: z.output<typeof staleLocationCardSchema>) => {
  // The recount age is the finding, so it leads. `inventoryEntries` is the
  // live population the `directItemCountMin` filter selected on.
  return problemRow(
    "location",
    r,
    [
      r.lastBulkInventory
        ? `last recounted ${householdLocalDate(r.lastBulkInventory)}`
        : "never recounted",
    ],
    [
      ...(r.type ? [textBadge(r.type)] : []),
      textBadge(countLabel(r.inventoryEntries.length, "item")),
    ],
  );
};

const toIngredientWithoutProduct = (
  r: z.output<typeof ingredientWithoutProductCardSchema>,
) => {
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
          const key = declaration.problem.key;
          return executeProblem(db, key, {
            fields: hasRowPresenter(key)
              ? PROBLEM_ROW_PRESENTERS[key].fields
              : undefined,
          });
        },
      ]),
    ),
    4,
  );

  return problemsViewsSchema.parse({
    ...Object.fromEntries(
      declarations.map(({ problem }) => [
        problem.key,
        results[problem.key]?.items ?? [],
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
