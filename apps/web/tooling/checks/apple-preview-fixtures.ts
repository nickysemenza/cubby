import { mealListItemOut } from "@cubby/schemas/entities/meal";
/**
 * The wire-shaped JSON `PreviewFixtures.swift` decodes for its `#Preview`s,
 * from the same Zod schemas the server validates output against. `pnpm
 * generate` writes one `apps/apple/Generated/PreviewFixtures/<name>.json` bundle
 * resource per fixture (gitignored).
 *
 * Each fixture below is `schema.parse(mock(schema, { seed, overrides }))` —
 * `mock-schema.ts`'s generator fills every field the schema requires, and
 * `overrides` pins only the values the previews actually render (names,
 * dates, statuses, projects, macros, …). When the API schema gains a new
 * required field, `mock()` synthesizes a placeholder for it instead of the
 * previews crashing at runtime (`PreviewFixtures.decode` fatalErrors on a
 * decode failure); when a schema drops or renames a field, `schema.parse`
 * here fails loudly at generation time instead.
 *
 * A JS array does not merge element-by-element against its schema (only
 * object keys do — see `mock-schema.ts`'s `mergeWithSchema`), so an array
 * fixture is built by mapping `mock()` over its own element schema and
 * assembling the results, never by overriding the array as a whole.
 *
 * All ids below are synthetic shortcodes: a valid body is 4 chars from
 * `SHORTCODE_CHARS` (digits 2-9, no 0/1/O/I/L — see
 * packages/shared/src/shortcode-alphabet.ts). Never a real household code
 * (AGENTS.md → synthetic data).
 */
import { faker } from "@faker-js/faker";
import { crc32, deflateSync } from "node:zlib";
import { z } from "zod";

import {
  expenseDetailOut,
  expenseListItemOut,
} from "@cubby/schemas/entities/expense";
import { inventoryListItemOut } from "@cubby/schemas/entities/inventory";
import {
  productDetailOut,
  productListItemOut,
} from "@cubby/schemas/entities/product";
import { taskDetailOut, taskListItemOut } from "@cubby/schemas/entities/task";
import {
  connectedRecordsOutputSchema,
  connectedRecordsPreviewOutputSchema,
} from "@cubby/schemas/connected-records";
import {
  detailActivityOutputSchema,
  monthlyExpenseSpendOutputSchema,
} from "@cubby/schemas/entity-detail-data";
import {
  entityReportManyOut,
  entityReportOut,
} from "@cubby/schemas/entity-report";
import { relatednessOutSchema } from "@cubby/schemas/relatedness";
import {
  createPaginatedResponseSchema,
  paginatedMetaSchema,
} from "@cubby/schemas/pagination";
import {
  fieldSuggestionRow,
  suggestionListOut,
} from "@cubby/schemas/suggestion-list";

import { entityTimelineOut } from "@cubby/schemas/entity-timeline";
import {
  mealNutritionOut,
  mealNutritionPerson,
  mealRecipeOut,
  mealTypeSchema,
  mealKindSchema,
} from "@cubby/schemas/meal";
import { rawMealList } from "@cubby/schemas/meal-raw-read";
import {
  entityReadFixture,
  fieldValueFixture,
} from "../../src/entity/fields/field-envelope.fixtures";
import { nutritionEstimate } from "@cubby/schemas/nutrition";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { taskTodayBriefingItemOut } from "@cubby/schemas/project";
import { completeTaskCommand } from "../../src/server/domains/task/repo/briefing-commands";
import { taskBriefingReport } from "../../src/server/domains/task/repo/report-task";

import { mock } from "../../src/lib/test/mock-schema";

// ---------------------------------------------------------------------------
// Shared value helpers, mirroring the shapes `nutritionTotals`/`measureEstimate`
// (packages/schemas/src/nutrition.ts) require.

const UNAVAILABLE = {
  status: "unavailable" as const,
  reason: "no_data" as const,
};

function estimate(value: number, status: "complete" | "partial" = "complete") {
  return {
    status,
    lower: value,
    upper: null,
    coverage: { covered: 1, total: 1 },
  };
}

/** `measureEstimate`'s `complete` variant for a known weight/share amount. */
function complete(value: number) {
  return estimate(value);
}

/** A deterministic UUID for a brand-only id field an array literal cannot leave to `mock()`. */
function uuidFor(seed: number): string {
  faker.seed(seed);
  return faker.string.uuid();
}

/**
 * A full `nutritionTotals`-shaped value. `nutrition` is an exhaustive record
 * over every `nutrientKey` (Zod 4 treats a record keyed by an enum as
 * exhaustive) — none of today's previews render it, so it is filled by
 * `mock()` rather than hand-typed; `macros` is the human-visible projection
 * previews actually show, so it is pinned exactly.
 */
function totalsOf(
  seed: number,
  macros:
    | {
        calories: number;
        protein: number;
        carbs: number;
        fat: number | undefined;
        status: "complete" | "partial";
      }
    | "unavailable",
) {
  const macrosValue =
    macros === "unavailable"
      ? {
          calories: UNAVAILABLE,
          protein: UNAVAILABLE,
          carbs: UNAVAILABLE,
          fat: UNAVAILABLE,
          partial: false,
        }
      : {
          calories: estimate(macros.calories, macros.status),
          protein: estimate(macros.protein, macros.status),
          carbs: estimate(macros.carbs, macros.status),
          fat:
            macros.fat === undefined
              ? UNAVAILABLE
              : estimate(macros.fat, macros.status),
          partial: macros.status === "partial",
        };
  return {
    cost: UNAVAILABLE,
    nutrition: mock(nutritionEstimate, { seed }),
    macros: macrosValue,
  };
}

// ---------------------------------------------------------------------------
// sampleTimeline: EntityTimelineOut — a product's movement timeline with one
// confident interval, one open unconfirmed one, a sale marker, two date
// groups.

function buildTimeline(): z.infer<typeof entityTimelineOut> {
  return mock(entityTimelineOut, {
    seed: 101,
    overrides: {
      groups: [
        {
          key: "2026-03-02",
          date: "2026-03-02",
          label: "Sample Vendor order",
          link: { entity: "purchase", id: "PUR-2345" },
          events: [
            {
              id: "EXP-2345",
              kind: "purchase",
              label: "Sample Product",
              amount: 12.5,
              link: { entity: "product", id: "PRD-2345" },
              detail: "1 each",
            },
            { id: "audit:1", kind: "audit:update", label: "Updated" },
          ],
        },
        {
          key: "2026-03-09",
          date: "2026-03-09",
          events: [
            {
              id: "EXP-3456",
              kind: "sale",
              label: "Sample Product",
              amount: -4,
            },
          ],
        },
      ],
      rows: [
        {
          id: "PRD-2345",
          name: "Sample Product",
          intervals: [
            { start: "2026-03-02", end: "2026-03-09", confident: true },
            { start: "2026-03-09", confident: false },
          ],
          markers: [{ date: "2026-03-09", kind: "sale" }],
        },
      ],
      stats: [{ key: "events", label: "Events", value: "3" }],
      notes: [],
      extent: { from: "2026-03-02", to: "2026-03-09" },
    },
  });
}

// ---------------------------------------------------------------------------
// The shared task briefing report for Today previews.

function buildTodayTasks(): z.infer<typeof taskTodayBriefingItemOut>[] {
  const items = [
    {
      id: "TSK-4K7M",
      name: "Refill pantry staples list",
      status: "in_progress" as const,
      dueDate: "2026-09-11",
      dueEndDate: null,
      projectId: "PRJ-3GHT",
      projectName: "Kitchen",
    },
    {
      id: "TSK-7QXN",
      name: "Ship the porcelain overhaul PR",
      status: "not_started" as const,
      dueDate: "2026-09-12",
      dueEndDate: null,
      projectId: "PRJ-8MNQ",
      projectName: "Cubby app",
    },
    {
      id: "TSK-9VBH",
      name: "Call the fridge repair vendor back",
      status: "not_started" as const,
      dueDate: null,
      dueEndDate: null,
      projectId: null,
      projectName: null,
    },
  ];
  return items.map((overrides, index) =>
    mock(taskTodayBriefingItemOut, {
      seed: 200 + index,
      overrides: {
        ...overrides,
        commands: [
          completeTaskCommand(parseShortcodeFor("task", overrides.id)),
        ],
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// sampleTodayMeals: [MealListItem] — today's meal list rows, for
// `TodayView`'s preview.

interface RecipeSpec {
  mealId: string;
  recipeId: string;
  name: string;
  sortOrder: number;
}

/** `id` (`MealRecipeId`, a UUID brand) is not previewed — left to `mock()`. */
function buildRecipe(
  seed: number,
  spec: RecipeSpec,
): z.infer<typeof mealRecipeOut> {
  return mock(mealRecipeOut, {
    seed,
    overrides: {
      mealId: spec.mealId,
      recipeId: spec.recipeId,
      recipe: {
        id: spec.recipeId,
        name: spec.name,
        yield: null,
        fields: {
          servings: fieldValueFixture(
            mealRecipeOut.shape.recipe.shape.fields.shape.servings,
            null,
          ),
          totals: fieldValueFixture(
            mealRecipeOut.shape.recipe.shape.fields.shape.totals,
            null,
          ),
        },
      },
      scale: 1,
      sortOrder: spec.sortOrder,
      estimatedYieldGrams: null,
      actualYieldGrams: null,
      scaledTotals: totalsOf(seed + 1, "unavailable"),
      createdAt: new Date("2026-09-14T10:00:00.000Z"),
      updatedAt: new Date("2026-09-14T10:00:00.000Z"),
    },
  });
}

type MealType = z.infer<typeof mealTypeSchema> | null;
type MealKind = z.infer<typeof mealKindSchema>;

interface MealSpec {
  id: string;
  name: string;
  mealType: MealType;
  mealKind: MealKind;
  recipeNames: readonly string[];
  recipeIds: readonly string[];
}

function buildMeal(
  seed: number,
  spec: MealSpec,
): z.infer<typeof mealListItemOut> {
  const recipes = spec.recipeNames.map((name, index) =>
    buildRecipe(seed + 10 + index, {
      mealId: spec.id,
      recipeId: spec.recipeIds[index]!,
      name,
      sortOrder: index,
    }),
  );
  const base = mock(rawMealList, {
    seed,
    overrides: {
      id: spec.id,
      date: "2026-09-14",
      name: spec.name,
      sortOrder: null,
      mealType: spec.mealType,
      mealKind: spec.mealKind,
      recipes: [],
      totals: totalsOf(seed + 2, "unavailable"),
      images: [],
      displayName: spec.name,
      recipeNames: [...spec.recipeNames],
      createdAt: new Date("2026-09-14T10:00:00.000Z"),
      updatedAt: new Date("2026-09-14T10:00:00.000Z"),
      dataQuality: {
        status: "complete",
        score: 100,
        facets: [],
        gaps: [],
        exceptions: [],
        relatedGaps: [],
        relatedExceptions: [],
      },
      displayImages: [],
    },
  });
  const fields = mealListItemOut.shape.fields.shape;
  return entityReadFixture(mealListItemOut, {
    ...base,
    recipes,
    fields: {
      mealType: fieldValueFixture(fields.mealType, spec.mealType),
      mealKind: fieldValueFixture(fields.mealKind, spec.mealKind),
      images: fieldValueFixture(fields.images, []),
      recipeNames: fieldValueFixture(fields.recipeNames, [...spec.recipeNames]),
      dataQuality: fieldValueFixture(fields.dataQuality, base.dataQuality),
      displayImages: fieldValueFixture(fields.displayImages, []),
    },
  });
}

function buildTodayMeals(): z.infer<typeof mealListItemOut>[] {
  return [
    buildMeal(500, {
      id: "MEL-5RTX",
      name: "Dinner",
      mealType: "dinner",
      mealKind: "cooked",
      recipeNames: ["Braised Short Ribs", "Roasted Carrots"],
      recipeIds: ["RCP-3PQZ", "RCP-6NJT"],
    }),
    buildMeal(520, {
      id: "MEL-8MKD",
      name: "Lunch",
      mealType: "lunch",
      mealKind: "leftovers",
      recipeNames: [],
      recipeIds: [],
    }),
  ];
}

// ---------------------------------------------------------------------------
// sampleMealNutrition: MealNutritionOut — two eaters splitting a shared
// recipe plus one solo food, for the meal nutrition breakdown preview.

const lunch = {
  id: "MEL-6TXQ",
  date: "2026-09-14",
  name: "Garden lunch",
  fields: {
    mealType: fieldValueFixture(
      mealListItemOut.shape.fields.shape.mealType,
      "lunch",
    ),
  },
};

function buildMealNutrition(): z.infer<typeof mealNutritionOut> {
  const alex = mock(mealNutritionPerson, {
    seed: 400,
    overrides: {
      eater: { id: "LPY-4K7M", name: "Alex" },
      totals: totalsOf(401, {
        calories: 642,
        protein: 31.4,
        carbs: 78.2,
        fat: 22.7,
        status: "partial",
      }),
      meals: [
        {
          meal: lunch,
          totals: totalsOf(402, {
            calories: 642,
            protein: 31.4,
            carbs: 78.2,
            fat: 22.7,
            status: "partial",
          }),
        },
      ],
      foods: [
        {
          sourceKind: "recipe",
          mealRecipeId: uuidFor(4031),
          recipeId: "RCP-3PQZ",
          sourceMealId: lunch.id,
          meal: lunch,
          name: "Tomato tart",
          amount: null,
          grams: 245,
          weight: complete(245),
          batchShare: complete(1),
          totals: totalsOf(403, {
            calories: 512,
            protein: 18.4,
            carbs: 62.2,
            fat: 21.1,
            status: "complete",
          }),
        },
        {
          sourceKind: "product",
          id: uuidFor(4041),
          productId: "PRD-7XQN",
          meal: lunch,
          name: "Greek yogurt",
          amount: null,
          grams: 170,
          weight: complete(170),
          batchShare: complete(1),
          totals: totalsOf(404, {
            calories: 130,
            protein: 13,
            carbs: 16,
            fat: undefined,
            status: "complete",
          }),
        },
      ],
    },
  });

  const sam = mock(mealNutritionPerson, {
    seed: 410,
    overrides: {
      eater: { id: "LPY-7QXN", name: "Sam" },
      totals: totalsOf(411, {
        calories: 488,
        protein: 21.8,
        carbs: 59.5,
        fat: 18.6,
        status: "complete",
      }),
      meals: [
        {
          meal: lunch,
          totals: totalsOf(412, {
            calories: 488,
            protein: 21.8,
            carbs: 59.5,
            fat: 18.6,
            status: "complete",
          }),
        },
      ],
      foods: [
        {
          sourceKind: "recipe",
          mealRecipeId: uuidFor(4131),
          recipeId: "RCP-3PQZ",
          sourceMealId: lunch.id,
          meal: lunch,
          name: "Tomato tart",
          amount: null,
          grams: 220,
          weight: complete(220),
          batchShare: complete(1),
          totals: totalsOf(413, {
            calories: 488,
            protein: 21.8,
            carbs: 59.5,
            fat: 18.6,
            status: "complete",
          }),
        },
      ],
    },
  });

  return mock(mealNutritionOut, {
    seed: 420,
    overrides: { meals: [lunch], people: [alex, sam] },
  });
}

// ---------------------------------------------------------------------------
// Entity screens: Product, Expense and Task list pages and detail reads for
// the native list/detail previews and `PreviewRenderTests`. Rows are parsed
// through each entity's generated list/detail schema, so envelope and
// projection drift fails generation. Native decodes them with
// `EntityDescriptor.row(from:)`, exactly as `entity.list` and `entity.detail`
// rows.

/** `PreviewFixtures.screenFixture` rewrites this day to the render day, so
 * "due today" stays today; every other date is absolute. */
const PREVIEW_TODAY = "2026-09-14";

/** Solid swatches standing in for photos, by fixture image name. */
const PREVIEW_SWATCHES = {
  skillet: [61, 64, 69],
  knife: [158, 168, 178],
  "olive-oil": [140, 153, 56],
  duvet: [219, 204, 179],
} as const satisfies Record<string, readonly [number, number, number]>;
type Swatch = keyof typeof PREVIEW_SWATCHES;

/** A 16×16 solid PNG as a `data:` URL: Nuke and `AsyncImage` decode it
 * locally, so thumbnails and the detail hero render with no network. */
function swatchURL(name: Swatch): string {
  const [red, green, blue] = PREVIEW_SWATCHES[name];
  const size = 16;
  const row = Buffer.from([
    0,
    ...Array.from({ length: size }, () => [red, green, blue]).flat(),
  ]);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function previewImage(id: string, name: Swatch) {
  return { id, url: swatchURL(name) };
}

/** Server action availability (`actions: [{id, enabled, reason}]`) for the
 * native action placement. The read schemas do not declare it yet, so it is
 * attached after parsing; native decodes it as extra row JSON until the
 * contract lands. */
type ActionAvailability = {
  id: string;
  enabled: boolean;
  reason: string | null;
};
const action = (id: string, reason: string | null = null) => ({
  id,
  enabled: reason === null,
  reason,
});

/**
 * One wire-shaped entity read. `values` is keyed by field or top-level key:
 * enveloped fields become live record-owned values, top-level keys are copied.
 * Everything unspecified is empty (null, `[]`, or an unset envelope) rather
 * than random, so a preview shows only the state a fixture names.
 */
const fixtureRecord = z.record(z.string(), z.unknown());

function entityRead<S extends z.ZodObject>(
  schema: S,
  seed: number,
  values: z.input<typeof fixtureRecord>,
  actions: readonly ActionAvailability[],
) {
  const declared = schema.shape.fields;
  if (!(declared instanceof z.ZodObject))
    throw new Error("An entity read fixture requires canonical fields");
  const base = fixtureRecord.parse(mock(schema, { seed }));
  const top = Object.fromEntries(
    Object.entries(schema.shape)
      .filter(([key]) => key !== "fields")
      .map(([key, field]) => {
        if (!(field instanceof z.ZodType))
          throw new Error("A fixture key requires a schema");
        if (key in values) return [key, values[key]];
        if (field.safeParse(null).success) return [key, null];
        if (field.safeParse([]).success) return [key, []];
        return [key, base[key]];
      }),
  );
  const fields = Object.fromEntries(
    Object.entries(declared.shape).map(([key, field]) => {
      if (!(field instanceof z.ZodType))
        throw new Error("A fixture field requires a schema");
      return [
        key,
        fieldValueFixture(field, key in values ? values[key] : null),
      ];
    }),
  );
  return { ...schema.parse({ ...top, fields }), actions };
}

/** An `entity.list` page of reads `entityRead` already parsed. */
function listPage(
  items: readonly { actions: readonly ActionAvailability[] }[],
  meta: Partial<z.input<typeof paginatedMetaSchema>> = {},
) {
  return createPaginatedResponseSchema(z.unknown()).parse({
    items,
    meta: paginatedMetaSchema.parse({
      pageIndex: 1,
      pageSize: 50,
      totalCount: items.length,
      hasNextPage: false,
      ...meta,
    }),
  });
}

const quality = (status: "complete" | "needs_data", gaps: string[] = []) => ({
  status,
  score: status === "complete" ? 100 : 40,
  facets: [],
  gaps: gaps.map((check) => ({
    check,
    facet: "identity",
    kind: "missing",
    targetType: "product",
    targetId: "PRD-2K7M",
    message: `Missing ${check}`,
  })),
  exceptions: [],
  relatedGaps: [],
  relatedExceptions: [],
});

const at = (day: string) => new Date(`${day}T16:00:00.000Z`);
const owner = (label: string, id: string) => ({
  label,
  ref: { entityKind: "ledgerParty", entityId: id },
  inherited: false,
});
const categorySchema = productListItemOut.shape.category.unwrap();
const category = (id: string, name: string) => ({
  id,
  name,
  fields: {
    path: fieldValueFixture(categorySchema.shape.fields.shape.path, [
      { id, name },
    ]),
  },
});

interface ProductSpec {
  id: string;
  name: string;
  brand?: [id: string, name: string];
  category?: [id: string, name: string];
  placement?: [locationId: string, path: string, onHand: number];
  onHand?: number;
  cost?: number;
  stockStatus?: string;
  image?: Swatch;
  owners?: ReturnType<typeof owner>[];
  needsData?: string[];
  actions?: ActionAvailability[];
}

const productActions = (overrides: ActionAvailability[] = []) => {
  const defaults = [
    action("update"),
    action("delete"),
    action("addToInventory"),
    action("recordSale"),
    action("discard"),
  ];
  return defaults.map(
    (entry) => overrides.find((override) => override.id === entry.id) ?? entry,
  );
};

function productValues(spec: ProductSpec) {
  return {
    id: spec.id,
    name: spec.name,
    createdAt: at("2026-03-02"),
    updatedAt: at("2026-09-12"),
    brandId: spec.brand?.[0] ?? null,
    brandName: spec.brand?.[1] ?? null,
    categoryId: spec.category?.[0] ?? null,
    category: spec.category ? category(...spec.category) : null,
    primaryPlacement: spec.placement
      ? {
          locationId: spec.placement[0],
          path: spec.placement[1],
          onHand: spec.placement[2],
        }
      : null,
    stockTracked: spec.onHand !== undefined,
    onHandUnits: spec.onHand ?? null,
    stockStatus: spec.stockStatus ?? null,
    cost: spec.cost === undefined ? null : { kind: "item", amount: spec.cost },
    price: spec.cost ?? null,
    owners: spec.owners ?? [],
    commodity: false,
    classificationEvidence: "",
    itemImageCount: spec.image ? 1 : 0,
    labelImageCount: 0,
    quantityLedger: {
      acquiredUnits: spec.onHand ?? 0,
      exitedUnits: 0,
      expectedQuantity: spec.onHand ?? 0,
      unknownAcquisitionLines: 0,
      unknownExitLines: 0,
      locationCount: spec.placement ? 1 : 0,
    },
    dataQuality: quality(
      spec.needsData ? "needs_data" : "complete",
      spec.needsData,
    ),
    displayImages: spec.image ? [previewImage("IMG-2K7M", spec.image)] : [],
  };
}

const ALEX = owner("Alex", "LPY-4K7M");
const SAM = owner("Sam", "LPY-7QXN");

const PRODUCTS: readonly ProductSpec[] = [
  {
    id: "PRD-2K7M",
    name: "Cast Iron Skillet",
    brand: ["VEN-2345", "Northfield Foundry"],
    category: ["CAT-2224", "Cookware"],
    placement: ["LOC-2345", "Kitchen › Pot drawer", 1],
    onHand: 1,
    cost: 34.99,
    image: "skillet",
    owners: [ALEX],
  },
  {
    id: "PRD-3QXN",
    name: "Chef's Knife, 8 in",
    brand: ["VEN-3456", "Harbor Steelworks"],
    category: ["CAT-2224", "Cookware"],
    placement: ["LOC-3456", "Kitchen › Knife block", 1],
    onHand: 1,
    cost: 89,
    image: "knife",
  },
  {
    id: "PRD-4VBH",
    name: "Arborio Rice",
    brand: ["VEN-4567", "Sample Mill"],
    category: ["CAT-3335", "Pantry"],
    placement: ["LOC-4567", "Pantry › Top shelf", 0.25],
    onHand: 0.25,
    cost: 6.49,
    stockStatus: "Low",
  },
  {
    id: "PRD-5RTX",
    name: "Olive Oil, Extra Virgin",
    brand: ["VEN-5678", "Grove & Press"],
    category: ["CAT-3335", "Pantry"],
    placement: ["LOC-4567", "Pantry › Top shelf", 1],
    onHand: 1,
    cost: 18.5,
    stockStatus: "Low",
    image: "olive-oil",
  },
  {
    id: "PRD-6NJT",
    name: "Cordless Drill",
    category: ["CAT-4446", "Tools"],
    placement: ["LOC-5678", "Garage › Pegboard", 1],
    onHand: 1,
    needsData: ["brand", "model"],
  },
  {
    id: "PRD-7XQN",
    name: "Linen Duvet Cover",
    brand: ["VEN-6789", "Sample Textiles"],
    category: ["CAT-5557", "Bedding"],
    placement: ["LOC-6789", "Bedroom › Closet shelf", 2],
    onHand: 2,
    cost: 129,
    image: "duvet",
    owners: [SAM],
  },
  {
    id: "PRD-8MKD",
    name: "Hand Soap Refill",
    brand: ["VEN-7892", "Sample Goods"],
    category: ["CAT-6668", "Household"],
    onHand: 0,
    cost: 11.25,
    stockStatus: "Out of stock",
    actions: [action("recordSale", "Nothing on hand to sell.")],
  },
  {
    id: "PRD-9VWZ",
    name: "Replacement Water Filter for the Refrigerator Door Dispenser",
    category: ["CAT-6668", "Household"],
    needsData: ["brand", "image"],
  },
];

function buildProductList() {
  return listPage(
    PRODUCTS.map((spec, index) =>
      entityRead(
        productListItemOut,
        600 + index,
        { ...productValues(spec), expenseTotal: spec.cost ?? null },
        productActions(spec.actions),
      ),
    ),
    { totalLabels: { price: "$289.23", expenseTotal: "$289.23" } },
  );
}

/** The skillet's detail: relations, one pending suggestion, and an
 * unavailable verb (`recordSale` while the only unit is in use). */
function buildProductDetail() {
  return entityRead(
    productDetailOut,
    700,
    {
      ...productValues(PRODUCTS[0]!),
      model: "No. 10",
      notes: "Seasoned with flaxseed oil; hand wash only.",
      tags: ["kitchen", "cast-iron"],
      coverImageUrl: swatchURL("skillet"),
      ownershipEvidence: {
        state: "owned",
        acquiredAt: "2026-03-02",
        exitedAt: null,
        confidenceLostAt: null,
      },
      nutritionDisplay: {
        source: "none",
        title: "Nutrition",
        basis: "",
        sourceNote: null,
        inferenceEvidence: null,
        rows: [],
      },
    },
    productActions([action("recordSale", "The only unit is checked out.")]),
  );
}

function buildProductStockedAt() {
  const entries = [
    {
      id: "INV-2K7M",
      location: ["LOC-2345", "Pot drawer"],
      amount: 1,
      verifiedAt: at("2026-09-01"),
    },
    {
      id: "INV-3QXN",
      location: ["LOC-5678", "Garage › Camping bin"],
      amount: 1,
      verifiedAt: null,
    },
  ] as const;
  return listPage(
    entries.map((entry, index) =>
      entityRead(
        inventoryListItemOut,
        720 + index,
        {
          id: entry.id,
          displayName: "Cast Iron Skillet",
          placement: "stock",
          verifiedAt: entry.verifiedAt,
          createdAt: at("2026-03-02"),
          updatedAt: at("2026-09-01"),
          product: mock(inventoryListItemOut.shape.product, {
            seed: 730 + index,
            overrides: { id: "PRD-2K7M", name: "Cast Iron Skillet" },
          }),
          location: mock(inventoryListItemOut.shape.location, {
            seed: 735 + index,
            overrides: { id: entry.location[0], name: entry.location[1] },
          }),
          locationId: entry.location[0],
          amount: { value: entry.amount, unit: "each" },
          ownerLedgerPartyId: "LPY-4K7M",
          dataQuality: quality("complete"),
          displayImages: [previewImage("IMG-2K7M", "skillet")],
        },
        [action("update"), action("delete")],
      ),
    ),
  );
}

function buildProductSuggestions() {
  const record = { entity: "product" as const, id: "PRD-2K7M" };
  const handle = uuidFor(741);
  const created = "2026-09-13T16:00:00.000Z";
  const row = mock(fieldSuggestionRow, {
    seed: 740,
    overrides: {
      id: handle,
      suggestionId: handle,
      fingerprint: "synthetic-fingerprint",
      record,
      summary: [
        { kind: "text", text: "Set brand to " },
        { kind: "record", ref: { entity: "vendor", id: "VEN-8MKD" } },
      ],
      strength: "strong",
      clean: true,
      impact: [{ kind: "quality_check", label: "Closes the brand check" }],
      matchedRules: [],
      automaticRule: null,
      createdAt: created,
      actions: [
        { verb: "accept", ownerOnly: false },
        { verb: "dismiss", ownerOnly: false },
      ],
      columns: {},
      evidence: {
        entity: "product",
        recordId: "PRD-2K7M",
        field: "brandId",
        currentValue: "VEN-2345",
        suggestedValue: "VEN-8MKD",
        confidence: 0.91,
        kind: "correction",
        status: "pending",
        runnerUpValue: null,
        runnerUpConfidence: null,
        correctValue: null,
        id: handle,
        suggestionId: handle,
        runId: null,
        createdAt: created,
      },
    },
  });
  return suggestionListOut.parse({
    items: [row],
    meta: { pageIndex: 1, pageSize: 50, totalCount: 1, cleanCount: 1 },
    next: null,
  });
}

interface ExpenseSpec {
  id: string;
  name: string;
  cost: number;
  date: string;
  settled: boolean;
  category?: [id: string, name: string];
  product?: [id: string, name: string, image: Swatch];
  lineKind?: string;
}

const EXPENSES: readonly ExpenseSpec[] = [
  {
    id: "EXP-2K7M",
    name: "Cast Iron Skillet",
    cost: 34.99,
    date: "2026-09-02",
    settled: true,
    category: ["SPC-2345", "Kitchen"],
    product: ["PRD-2K7M", "Cast Iron Skillet", "skillet"],
  },
  {
    id: "EXP-3QXN",
    name: "Linen Duvet Cover",
    cost: 129,
    date: "2026-09-10",
    settled: false,
    category: ["SPC-3456", "Home"],
    product: ["PRD-7XQN", "Linen Duvet Cover", "duvet"],
  },
  {
    id: "EXP-4VBH",
    name: "Return: Olive Oil, Extra Virgin",
    cost: -18.5,
    date: "2026-09-12",
    settled: true,
    category: ["SPC-4567", "Groceries"],
    product: ["PRD-5RTX", "Olive Oil, Extra Virgin", "olive-oil"],
    lineKind: "other_adjustment",
  },
  {
    id: "EXP-5RTX",
    name: "Shipping",
    cost: 7.95,
    date: "2026-09-10",
    settled: false,
    lineKind: "shipping",
  },
  {
    id: "EXP-6NJT",
    name: "Drill bit set",
    cost: 24,
    date: PREVIEW_TODAY,
    settled: false,
    category: ["SPC-5678", "Tools"],
  },
];

function expenseValues(spec: ExpenseSpec) {
  return {
    id: spec.id,
    name: spec.name,
    cost: spec.cost,
    date: spec.date,
    createdAt: at(spec.date),
    updatedAt: at(spec.date),
    lineBasis: "item_line",
    lineKind: spec.lineKind ?? "principal",
    economicRole: "vendor",
    future: false,
    spendingCategoryId: spec.category?.[0] ?? null,
    spendingCategoryName: spec.category?.[1] ?? null,
    productId: spec.product?.[0] ?? null,
    productName: spec.product?.[1] ?? null,
    productQuantity: spec.product ? 1 : null,
    vendor: "Sample Supply Co.",
    vendorId: "VEN-9VWZ",
    purchaseId: "PUR-2345",
    purchaseDisplayLabel: "Sample Supply Co. · Sep 2",
    bookingTransactionCode: spec.settled ? "FTX-2K7M" : null,
    funders: spec.settled ? [{ partyId: "LPY-4K7M", weight: 1 }] : [],
    beneficiaries: [],
    dataQuality: quality("complete"),
    // The server resolves the declared related display source (the linked
    // Product's image), so the row borrows its thumbnail.
    displayImages: spec.product
      ? [previewImage("IMG-3QXN", spec.product[2])]
      : [],
  };
}

const expenseActions = [action("update"), action("delete")];

function buildExpenseList() {
  return listPage(
    EXPENSES.map((spec, index) =>
      entityRead(
        expenseListItemOut,
        800 + index,
        expenseValues(spec),
        expenseActions,
      ),
    ),
    { totalLabels: { cost: "$177.44" } },
  );
}

function buildExpenseDetail() {
  return entityRead(
    expenseDetailOut,
    820,
    {
      ...expenseValues(EXPENSES[0]!),
      notes: "Bought alongside the camping kit.",
      orderUrl: "https://example.invalid/orders/2345",
    },
    expenseActions,
  );
}

interface TaskSpec {
  id: string;
  name: string;
  status: "not_started" | "later" | "in_progress" | "blocked" | "done";
  due?: string;
  project?: [id: string, name: string];
  assignee?: [id: string, name: string];
  subject?: [id: string, name: string];
  parent?: [id: string, name: string];
  subtasks?: [count: number, done: number];
}

const KITCHEN = ["PRJ-3GHT", "Kitchen refresh"] as const;

const TASKS: readonly TaskSpec[] = [
  {
    id: "TSK-2K7M",
    name: "Re-season the cast iron skillet",
    status: "not_started",
    due: "2026-09-08",
    project: [...KITCHEN],
    assignee: ["LPY-4K7M", "Alex"],
    subject: ["PRD-2K7M", "Cast Iron Skillet"],
  },
  {
    id: "TSK-3QXN",
    name: "Restock pantry staples",
    status: "in_progress",
    due: PREVIEW_TODAY,
    project: [...KITCHEN],
    assignee: ["LPY-7QXN", "Sam"],
    subtasks: [3, 1],
  },
  {
    id: "TSK-4VBH",
    name: "Replace the refrigerator water filter",
    status: "blocked",
    due: "2026-10-01",
    subject: ["PRD-9VWZ", "Replacement Water Filter"],
  },
  {
    id: "TSK-5RTX",
    name: "Sharpen the chef's knife",
    status: "done",
    due: "2026-09-05",
    project: [...KITCHEN],
  },
  {
    id: "TSK-6NJT",
    name: "Sort the garage pegboard",
    status: "later",
  },
];

const SUBTASKS: readonly TaskSpec[] = [
  {
    id: "TSK-7XQN",
    name: "Check rice and grains",
    status: "done",
    parent: ["TSK-3QXN", "Restock pantry staples"],
  },
  {
    id: "TSK-8MKD",
    name: "Refill olive oil",
    status: "not_started",
    due: PREVIEW_TODAY,
    parent: ["TSK-3QXN", "Restock pantry staples"],
    subject: ["PRD-5RTX", "Olive Oil, Extra Virgin"],
  },
  {
    id: "TSK-9VWZ",
    name: "Order hand soap refills",
    status: "not_started",
    parent: ["TSK-3QXN", "Restock pantry staples"],
  },
];

function taskValues(spec: TaskSpec) {
  return {
    id: spec.id,
    name: spec.name,
    status: spec.status,
    due: spec.due ? { start: spec.due, end: null } : null,
    createdAt: at("2026-09-01"),
    updatedAt: at("2026-09-12"),
    projectId: spec.project?.[0] ?? null,
    projectName: spec.project?.[1] ?? null,
    assigneeId: spec.assignee?.[0] ?? null,
    assigneeName: spec.assignee?.[1] ?? null,
    subjectProductId: spec.subject?.[0] ?? null,
    subjectProductName: spec.subject?.[1] ?? null,
    parentTaskId: spec.parent?.[0] ?? null,
    parentTaskName: spec.parent?.[1] ?? null,
    subtaskCount: spec.subtasks?.[0] ?? 0,
    doneSubtaskCount: spec.subtasks?.[1] ?? 0,
    images: [],
    dataQuality: quality("complete"),
    // A Task with a subject Product borrows its image (declared display source).
    displayImages:
      spec.subject?.[0] === "PRD-2K7M"
        ? [previewImage("IMG-2K7M", "skillet")]
        : [],
  };
}

const taskActions = (spec: TaskSpec) => [
  action("update"),
  action("delete"),
  action("complete", spec.status === "done" ? "Already done." : null),
];

function taskRows(specs: readonly TaskSpec[], seed: number) {
  return specs.map((spec, index) =>
    entityRead(
      taskListItemOut,
      seed + index,
      taskValues(spec),
      taskActions(spec),
    ),
  );
}

function buildTaskDetail() {
  const spec = TASKS[1]!;
  return entityRead(
    taskDetailOut,
    920,
    { ...taskValues(spec), blockingIds: ["TSK-4VBH"] },
    taskActions(spec),
  );
}

/** The twelve `YYYY-MM` months ending in `PREVIEW_TODAY`'s month, oldest first. */
function previewMonths(): string[] {
  const today = new Date(`${PREVIEW_TODAY}T00:00:00Z`);
  const end = today.getUTCFullYear() * 12 + today.getUTCMonth();
  return Array.from({ length: 12 }, (_, index) => {
    const offset = end - (11 - index);
    return `${Math.floor(offset / 12)}-${String((offset % 12) + 1).padStart(2, "0")}`;
  });
}

/**
 * The detail screen's secondary reads, answered by the preview network
 * (`PreviewOperationResponses`) instead of failing: `operations` maps an
 * operation id to its `data`, `connectedRecords` maps a summary view key to
 * its `entity.connectedRecords` page. Unlisted operations still fail locally.
 */
function detailReads(
  source: { entity: string; id: string },
  reports: Record<string, z.input<typeof entityReportOut>["blocks"]>,
  connected: Record<
    string,
    { entity: string; records: [id: string, label: string][] }
  >,
  spend: [month: string, cents: number][] = [],
  timeline?: z.infer<typeof entityTimelineOut>,
) {
  const node = (entityKind: string, entityId: string, label: string) => ({
    entityKind,
    entityId,
    label,
  });
  const root = node(source.entity, source.id, "");
  return {
    operations: {
      "entityReport.getMany": entityReportManyOut.parse({
        reports: Object.entries(reports).map(([slot, blocks]) => ({
          slot,
          report: { blocks },
        })),
      }),
      "entity.detailActivity": detailActivityOutputSchema.parse({
        items: [],
        nextCursor: null,
      }),
      "entity.connectedRecordsPreview":
        connectedRecordsPreviewOutputSchema.parse({ views: [] }),
      // The detail's Related records section reads this for embeddable entities.
      "relatedness.forEntity": relatednessOutSchema.parse({
        status: "ready",
        items: [],
      }),
      ...(timeline ? { "entity.timeline": timeline } : {}),
      // The server always returns the twelve months ending in the current one.
      "entity.monthlyExpenseSpend": monthlyExpenseSpendOutputSchema.parse(
        previewMonths().map((month) => ({
          month,
          cents: spend.find(([spent]) => spent === month)?.[1] ?? 0,
        })),
      ),
    },
    connectedRecords: Object.fromEntries(
      Object.entries(connected).map(([viewKey, view]) => [
        viewKey,
        connectedRecordsOutputSchema.parse({
          targetEntity: view.entity,
          totalCount: view.records.length,
          items: view.records.map(([id, label]) => ({
            target: node(view.entity, id, label),
            paths: [[root, node(view.entity, id, label)]],
            shortestHops: 1,
          })),
        }),
      ]),
    ),
  };
}

const stats = (
  figures: {
    label: string;
    value: number | null;
    format: "money" | "count" | "text";
    text?: string;
  }[],
) => ({ kind: "stats" as const, figures });
const note = (text: string) => ({ kind: "note" as const, text });

const buildProductDetailReads = () =>
  detailReads(
    { entity: "product", id: "PRD-2K7M" },
    {
      "product.stock-summary": [
        stats([
          { label: "On hand", value: 2, format: "count" },
          { label: "Locations", value: 2, format: "count" },
        ]),
      ],
      "product.use-summary": [note("Not used in any recipe.")],
      "product.sellers": [note("Sample Supply Co.")],
      "product.pricing-summary": [
        stats([
          { label: "Purchases", value: 1, format: "count" },
          { label: "Spent", value: 34.99, format: "money" },
        ]),
      ],
      "product.evidence-summary": [note("1 receipt · 1 photo")],
    },
    {
      "purchase-projects": {
        entity: "project",
        records: [["PRJ-3GHT", "Kitchen refresh"]],
      },
      // Relation sections request path evidence for their visible rows.
      "relation:inventory": {
        entity: "inventory",
        records: [
          ["INV-2K7M", "Cast Iron Skillet"],
          ["INV-3QXN", "Cast Iron Skillet"],
        ],
      },
    },
    [
      ["2026-03", 3499],
      ["2026-09", 0],
    ],
    buildTimeline(),
  );

const buildExpenseDetailReads = () =>
  detailReads(
    { entity: "expense", id: "EXP-2K7M" },
    {
      "expense.settlement": [
        stats([
          {
            label: "Settled",
            value: null,
            format: "text",
            text: "Paid by Alex",
          },
        ]),
      ],
      "expense.attribution-summary": [note("Household · split evenly")],
    },
    {
      "relation:product": {
        entity: "product",
        records: [["PRD-2K7M", "Cast Iron Skillet"]],
      },
      "relation:purchase": {
        entity: "purchase",
        records: [["PUR-2345", "Sample Supply Co. · Sep 2"]],
      },
    },
  );

const buildTaskDetailReads = () =>
  detailReads(
    { entity: "task", id: "TSK-3QXN" },
    {},
    {
      "relation:project": {
        entity: "project",
        records: [[...KITCHEN]],
      },
      "relation:assignee": {
        entity: "ledgerParty",
        records: [["LPY-7QXN", "Sam"]],
      },
      "relation:blocked-by": { entity: "task", records: [] },
      "relation:subject": { entity: "product", records: [] },
      "relation:subtasks": {
        entity: "task",
        records: SUBTASKS.map((task) => [task.id, task.name]),
      },
      "relation:parent": { entity: "task", records: [] },
      "relation:images": { entity: "image", records: [] },
    },
  );

// ---------------------------------------------------------------------------

interface Fixture {
  /** The resource name `PreviewFixtures.decode` loads. */
  name: string;
  /** Each fixture's build function returns its own zod-inferred type; this table only ever
   * needs to serialize the result, never inspect its shape. */
  build: () => object;
}

const FIXTURES: readonly Fixture[] = [
  { name: "sampleTimeline", build: buildTimeline },
  {
    name: "sampleTodayBriefing",
    build: () =>
      taskBriefingReport({
        next: buildTodayTasks(),
        nextCount: 4,
        laterCount: 2,
        blockedCount: 1,
        overdueCount: 0,
        dueThisWeekCount: 2,
      }),
  },
  { name: "sampleTodayMeals", build: buildTodayMeals },
  { name: "sampleMealNutrition", build: buildMealNutrition },
  { name: "productList", build: buildProductList },
  { name: "productDetail", build: buildProductDetail },
  { name: "productStockedAt", build: buildProductStockedAt },
  { name: "productSuggestions", build: buildProductSuggestions },
  { name: "expenseList", build: buildExpenseList },
  { name: "expenseDetail", build: buildExpenseDetail },
  {
    name: "taskList",
    build: () => listPage(taskRows(TASKS, 900)),
  },
  { name: "taskDetail", build: buildTaskDetail },
  { name: "productDetailReads", build: buildProductDetailReads },
  { name: "expenseDetailReads", build: buildExpenseDetailReads },
  { name: "taskDetailReads", build: buildTaskDetailReads },
  {
    name: "taskSubtasks",
    build: () => listPage(taskRows(SUBTASKS, 940)),
  },
];

export const renderApplePreviewFixtures = () => {
  faker.seed(1);
  return FIXTURES.map(({ name, build }) => ({
    relativePath: `apps/apple/Generated/PreviewFixtures/${name}.json`,
    source: `${JSON.stringify(build(), null, 2)}\n`,
  }));
};
