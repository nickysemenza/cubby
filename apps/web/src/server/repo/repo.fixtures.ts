import type { ActorContext } from "@cubby/schemas/context";
import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { ProductCreateInput } from "@cubby/schemas/product";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import type { Database } from "~/server/db";
import { createIngredient } from "./ingredient";

// Shared fixture builders for the repo integration tests. Each factory states
// the irrelevant scaffolding fields once so a test only spells out the values
// its assertions depend on. NB: `buildTestDB()` already returns an `actor`
// ({ userId: TEST_USER_ID, source: "ui" }) — destructure that instead of
// redefining a TEST_ACTOR constant per file. The `.fixtures.ts` suffix keeps
// this file out of the test glob.

type Amount = { value: number; unit: string };
type RecipeIngredientInput = NonNullable<
  RecipeCreateInput["sections"][number]["ingredients"]
>[number];

/** A product create input with sensible defaults; override what the test cares about. */
export const makeProductInput = (
  overrides: Partial<ProductCreateInput> = {},
): ProductCreateInput => ({
  name: "Test Product",
  manufacturer: "Test Manufacturer",
  model: "TEST-123",
  upc: null,
  ndb_number: null,
  fdc_id: null,
  expectedQuantity: null,
  ingredientId: null,
  unitMappings: [],
  externalIds: [],
  ...overrides,
});

/** A section's ingredient row (collapses the type/recipeId/amounts boilerplate). */
export const ingredientRef = (
  id: string,
  opts: { amounts?: Amount[]; modifier?: string; rawLine?: string } = {},
): RecipeIngredientInput => ({
  type: "ingredient" as const,
  ingredientId: unsafeIngredientId(id),
  recipeId: null,
  amounts: opts.amounts ?? [{ value: 1, unit: "cup" }],
  ...(opts.modifier !== undefined ? { modifier: opts.modifier } : {}),
  ...(opts.rawLine !== undefined ? { rawLine: opts.rawLine } : {}),
});

/** A direct (non-cookbook) recipe create input with defaults. */
export const makeRecipeInput = (
  opts: {
    name?: string;
    url?: string | null;
    sections?: RecipeCreateInput["sections"];
  } = {},
): RecipeCreateInput => ({
  name: opts.name ?? "Test Recipe",
  meta: { url: opts.url ?? null },
  sections: opts.sections ?? [],
});

/** A raw ImportRecipe (the parser's shape; lines parsed server-side on import). */
export const makeImportRecipe = (
  overrides: Partial<ImportRecipe> = {},
): ImportRecipe => ({
  meta: { title: "Test Recipe" },
  sections: [{ instructions: [], ingredients: [] }],
  references: [],
  ...overrides,
});

/** Convenience for the common cookbook shape: one section of bare ingredient lines. */
export const cookbookRecipe = (
  title: string,
  ingredients: string[],
  overrides: Partial<ImportRecipe> = {},
): ImportRecipe =>
  makeImportRecipe({
    meta: { title },
    sections: [{ ingredients, instructions: [] }],
    ...overrides,
  });

/** Seed N ingredients by name, returning the created rows in order. */
export const createIngredients = (
  db: Database,
  names: string[],
  actor: ActorContext,
): Promise<Awaited<ReturnType<typeof createIngredient>>[]> =>
  names.reduce<Promise<Awaited<ReturnType<typeof createIngredient>>[]>>(
    async (accP, name) => {
      const acc = await accP;
      acc.push(await createIngredient(db, { name, aliases: [] }, actor));
      return acc;
    },
    Promise.resolve([]),
  );
