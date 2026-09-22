/**
 * Regenerates the wire-shaped JSON constants `PreviewFixtures.swift` decodes
 * for its `#Preview`s, from the same Zod schemas the server validates output
 * against.
 *
 *   tsx scripts/generate-apple-preview-fixtures.ts           write the committed Swift file
 *   tsx scripts/generate-apple-preview-fixtures.ts --check   fail if it would change
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
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { faker } from "@faker-js/faker";
import type { z } from "zod";

import { entityTimelineOut } from "@cubby/schemas/entity-timeline";
import {
  mealListItemOut,
  mealNutritionOut,
  mealNutritionPerson,
} from "@cubby/schemas/meal";
import { mealRecipeOut } from "@cubby/schemas/meal-fields";
import { nutritionEstimate } from "@cubby/schemas/nutrition";
import { problemsCountSchema } from "@cubby/schemas/problems";
import { taskTodayBriefingItemOut } from "@cubby/schemas/project";

import { mock } from "../src/lib/test/mock-schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(
  __dirname,
  "../../apple/App/Shared/Previews/PreviewFixtures+Generated.swift",
);

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
// sampleTodayTasks: [TaskTodayBriefingItemOut] — `task.todayBriefing`'s
// `next` rows, for `TodayView`'s preview.

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
    mock(taskTodayBriefingItemOut, { seed: 200 + index, overrides }),
  );
}

// ---------------------------------------------------------------------------
// sampleTodayMeals: [MealListItem] — today's `GET /api/v1/meals` rows, for
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
        servings: null,
        yield: null,
        totals: null,
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

type MealType = z.infer<typeof mealListItemOut>["mealType"];
type MealKind = z.infer<typeof mealListItemOut>["mealKind"];

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
  return mock(mealListItemOut, {
    seed,
    overrides: {
      id: spec.id,
      date: "2026-09-14",
      name: spec.name,
      sortOrder: null,
      mealType: spec.mealType,
      mealKind: spec.mealKind,
      recipes,
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
// sampleTodayProblems: ProblemsCount — `problems/getCounts`, for
// `TodayView`'s preview; every per-check count is zero. `byType`'s keys are
// read straight off the schema, so a new check can never drift this preview
// out of sync with what the server actually counts (the schema itself would
// then fail `schema.parse` first, at generation time).

function buildProblemsCount(): z.infer<typeof problemsCountSchema> {
  const byTypeKeys = Object.keys(problemsCountSchema.shape.byType.shape);
  const zeroByType = Object.fromEntries(byTypeKeys.map((key) => [key, 0]));
  return mock(problemsCountSchema, {
    seed: 300,
    overrides: { total: 14, coverageTotal: 3, byType: zeroByType },
  });
}

// ---------------------------------------------------------------------------
// sampleMealNutrition: MealNutritionOut — two eaters splitting a shared
// recipe plus one solo food, for the meal nutrition breakdown preview.

const lunch = {
  id: "MEL-6TXQ",
  date: "2026-09-14",
  name: "Garden lunch",
  mealType: "lunch" as const,
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

interface Fixture {
  /** The `static let <name>` this becomes in `PreviewFixtures.swift`. */
  swiftName: string;
  /** The OpenAPI component this fixture's wire shape corresponds to. */
  component: string;
  /** Each fixture's build function returns its own zod-inferred type; this table only ever
   * needs to serialize the result, never inspect its shape. */
  build: () => object;
}

const FIXTURES: readonly Fixture[] = [
  {
    swiftName: "sampleTimeline",
    component: "EntityTimelineOut",
    build: buildTimeline,
  },
  {
    swiftName: "sampleTodayTasks",
    component: "TaskTodayBriefingItemOut[]",
    build: buildTodayTasks,
  },
  {
    swiftName: "sampleTodayMeals",
    component: "MealListItem[]",
    build: buildTodayMeals,
  },
  {
    swiftName: "sampleTodayProblems",
    component: "ProblemsCount",
    build: buildProblemsCount,
  },
  {
    swiftName: "sampleMealNutrition",
    component: "MealNutritionOut",
    build: buildMealNutrition,
  },
];

function renderSwift(): string {
  faker.seed(1);
  const lines: string[] = [
    "// Generated by `pnpm --dir apps/web run gen:apple-preview-fixtures` — do not edit.",
    "// Source: apps/web/scripts/generate-apple-preview-fixtures.ts",
    "//",
    "// Wire-shaped JSON for `PreviewFixtures.swift`'s `decode(_:)` calls, produced from the",
    "// same Zod schemas (`@cubby/schemas`) the server validates its responses against — see",
    "// the generator script's header for how each fixture is built.",
    "",
    "import Foundation",
    "",
    "extension PreviewFixtures {",
  ];
  for (const [index, fixture] of FIXTURES.entries()) {
    const json = JSON.stringify(fixture.build(), null, 2);
    lines.push(`    /// Wire shape: \`${fixture.component}\`.`);
    lines.push(`    static let ${fixture.swiftName}JSON = #"""`);
    // Swift strips the closing delimiter's indentation from every line of a multi-line string
    // literal and rejects any line indented less; 8 spaces is what `swift format` produces, so
    // the committed file passes `swift format lint --strict` in `pnpm apple check`.
    for (const line of json.split("\n")) lines.push(`        ${line}`);
    lines.push('        """#');
    if (index < FIXTURES.length - 1) lines.push("");
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const check = process.argv.includes("--check");
  const rendered = renderSwift();
  if (check) {
    let committed: string | undefined;
    try {
      committed = readFileSync(OUTPUT, "utf8");
    } catch {
      committed = undefined;
    }
    if (committed !== rendered) {
      console.error(
        `PreviewFixtures+Generated.swift is stale; run: pnpm --dir apps/web run gen:apple-preview-fixtures`,
      );
      process.exit(1);
    }
    console.log("PreviewFixtures+Generated.swift is up to date.");
    return;
  }
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, rendered);
  console.log(`Wrote ${OUTPUT}`);
}

main();
