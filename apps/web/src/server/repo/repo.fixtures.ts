import type { ActorContext } from "@cubby/schemas/context";
import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import {
  type LocationCreateInput,
  locationCreateInput,
} from "@cubby/schemas/location";
import type { ProductCreateInput } from "@cubby/schemas/product";
import type { ExpenseCreateInput } from "@cubby/schemas/project";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { mock } from "~/lib/test/mock-schema";
import type { Database } from "~/server/db";
import { createIngredient, findOrCreateIngredient } from "./ingredient";
import { createInventoryEntry } from "./inventory";
import { createLocation } from "./location";
import { createProduct } from "./product";

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
  aliases: [],
  tags: [],
  manufacturer: "Test Manufacturer",
  model: "TEST-123",
  upc: null,
  fdc_id: null,
  expectedQuantity: null,
  ingredientId: null,
  unitMappings: [],
  externalIds: [],
  ...overrides,
});

/** An expense create input; every link (project/product/purchase) defaults to
 * unset so a test spells out only the relation it's asserting on. Passing
 * `vendor` still works and resolves into a real `Vendor` + `Purchase` — that
 * unchanged input shape is the point of the split. */
export const makeExpenseInput = (
  overrides: Partial<ExpenseCreateInput> = {},
): ExpenseCreateInput => ({
  name: "Test Expense",
  cost: 100,
  date: null,
  costType: "materials",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  projectId: null,
  productId: null,
  purchaseId: null,
  vendor: null,
  orderId: null,
  ...overrides,
});

/** Standard tRPC `list` input ({ filters, pagination, sort }). Defaults match the
 * dominant call shape (name/asc, page 0 × 10); override only what a test varies.
 * `filters` is generic so the entity's filter type is inferred at the call site. */
export const listParams = <F = Record<string, never>>(
  overrides: {
    filters?: F;
    pageSize?: number;
    pageIndex?: number;
    orderBy?: string;
    direction?: "asc" | "desc";
  } = {},
) => ({
  filters: (overrides.filters ?? {}) as F,
  pagination: {
    pageSize: overrides.pageSize ?? 10,
    pageIndex: overrides.pageIndex ?? 0,
  },
  sort: {
    orderBy: overrides.orderBy ?? "name",
    direction: overrides.direction ?? ("asc" as const),
  },
});

/** A location create input; `mock()` fills the scaffolding (parentId/images) so a
 * call site need only spell out the name (and type, when it matters). */
export const makeLocationInput = (
  overrides: Partial<LocationCreateInput> = {},
): LocationCreateInput =>
  mock(locationCreateInput, {
    overrides: {
      name: "Test Location",
      type: "room",
      parentId: null,
      ...overrides,
    },
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
    tags?: RecipeCreateInput["tags"];
  } = {},
): RecipeCreateInput => ({
  name: opts.name ?? "Test Recipe",
  meta: { url: opts.url ?? null },
  sections: opts.sections ?? [],
  // Passed through only when the caller opts in, so the default stays a
  // tags-absent input rather than an explicit null.
  ...("tags" in opts ? { tags: opts.tags } : {}),
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

// The 1 cup = 120 g conversion every stock-seed product carries, so an `onHand`
// in grams is costable/convertible.
const CUP_TO_GRAM = {
  a: { value: 1, unit: "cup" },
  b: { value: 120, unit: "g" },
  source: null,
};

/** Seed an ingredient backed by a "Test <name>" product (1 cup = 120 g) with
 * `onHand` stock at a "Pantry-<name>" location — the shared ingredient+stock setup
 * for the meal/suggestions/availability suites. Returns the ingredient. */
export const seedIngredientWithStock = async (
  db: Database,
  opts: { name: string; onHand: Amount },
  actor: ActorContext,
) => {
  const ingredient = await findOrCreateIngredient(db, opts.name);
  const location = await createLocation(
    db,
    makeLocationInput({ name: `Pantry-${opts.name}` }),
    actor,
  );
  if (!location) throw new Error("seed: location not created");
  const product = await createProduct(
    db,
    makeProductInput({
      name: `Test ${opts.name}`,
      manufacturer: "test",
      ingredientId: ingredient.id,
      unitMappings: [CUP_TO_GRAM],
    }),
    actor,
  );
  await createInventoryEntry(
    db,
    { productId: product.id, locationId: location.id, amount: opts.onHand },
    actor,
  );
  return ingredient;
};
