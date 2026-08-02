import type { ActorContext } from "@cubby/schemas/context";
import {
  type IngredientId,
  type IngredientShortcode,
  unsafeIngredientId,
  unsafeIngredientShortcode,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeMealId,
  unsafeProductId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import {
  type LocationCreateInput,
  locationCreateInput,
} from "@cubby/schemas/location";
import type { MealCreateInput } from "@cubby/schemas/meal";
import type { ProductCreateInput } from "@cubby/schemas/product";
import type { ExpenseCreateInput } from "@cubby/schemas/project";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { mock } from "~/lib/test/mock-schema";
import type { Database } from "~/server/db";
import { createIngredient, findOrCreateIngredient } from "./ingredient";
import { createInventoryEntry } from "./inventory";
import { createLocation } from "./location";
import { createMeal } from "./meal";
import { createProduct } from "./product";
import { createRecipe } from "./recipe";
import { resolveLiveShortcode } from "./shortcode-resolver";

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

type ProductFixtureInput<
  Ingredient extends IngredientId | IngredientShortcode | null | undefined,
> = Omit<ProductCreateInput, "ingredientId"> & {
  ingredientId: Ingredient extends undefined ? null : Ingredient;
};

/**
 * A product create input with sensible defaults; override what the test cares
 * about. The ingredient brand is preserved so the same test-only builder can
 * seed the UUID-only repo boundary or exercise the shortcode-only router.
 */
export const makeProductInput = <
  Ingredient extends
    | IngredientId
    | IngredientShortcode
    | null
    | undefined = undefined,
>(
  overrides: Omit<Partial<ProductCreateInput>, "ingredientId"> & {
    ingredientId?: Ingredient;
  } = {},
): ProductFixtureInput<Ingredient> =>
  ({
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
  }) as ProductFixtureInput<Ingredient>;

/**
 * Create a product for a repo integration test while retaining both sides of
 * the boundary. Public assertions use `id`; UUID-only repo writes use
 * `entityId`. A public ingredient id is resolved here so callers never cast a
 * shortcode into a FK brand.
 */
export const createProductFixture = async (
  db: Database,
  data: Omit<ProductCreateInput, "ingredientId"> & {
    ingredientId?: string | null;
  },
  actor: ActorContext,
) => {
  const rawIngredientId = data.ingredientId ?? null;
  const resolvedIngredientId = rawIngredientId?.startsWith("ING-")
    ? await resolveLiveShortcode(db, rawIngredientId, "ingredient")
    : rawIngredientId;
  if (rawIngredientId && !resolvedIngredientId) {
    throw new Error(`fixture: ingredient ${rawIngredientId} not found`);
  }
  const output = await createProduct(
    db,
    {
      ...data,
      ingredientId: resolvedIngredientId
        ? unsafeIngredientId(resolvedIngredientId)
        : null,
    },
    actor,
  );
  const resolvedProductId = await resolveLiveShortcode(
    db,
    output.id,
    "product",
  );
  if (!resolvedProductId) throw new Error("fixture: created product not found");
  return { ...output, entityId: unsafeProductId(resolvedProductId) };
};

/** Public ingredient output plus its private UUID for repo-only writes. */
export const createIngredientFixture = async (
  db: Database,
  data: Parameters<typeof createIngredient>[1],
  actor: ActorContext,
) => {
  const output = await createIngredient(db, data, actor);
  const resolvedIngredientId = await resolveLiveShortcode(
    db,
    output.id,
    "ingredient",
  );
  if (!resolvedIngredientId) throw new Error("fixture: ingredient not found");
  return { ...output, entityId: unsafeIngredientId(resolvedIngredientId) };
};

/** Public location output plus the UUID needed by repo-only fixture writes. */
export const createLocationFixture = async (
  db: Database,
  data: LocationCreateInput,
  actor: ActorContext,
) => {
  const output = await createLocation(db, data, actor);
  if (!output) throw new Error("fixture: location not created");
  const resolvedLocationId = await resolveLiveShortcode(
    db,
    output.id,
    "location",
  );
  if (!resolvedLocationId)
    throw new Error("fixture: created location not found");
  return { ...output, entityId: unsafeLocationId(resolvedLocationId) };
};

/**
 * Create inventory from canonical public product/location ids and retain the
 * private row id for direct repo reads and reconciliation fixtures.
 */
export const createInventoryFixture = async (
  db: Database,
  data: {
    productId: string;
    locationId: string;
    amount: Amount;
    verifiedAt?: Date | null;
  },
  actor: ActorContext,
) => {
  const [rawProductId, rawLocationId] = await Promise.all([
    data.productId.startsWith("PRD-")
      ? resolveLiveShortcode(db, data.productId, "product")
      : Promise.resolve(data.productId),
    data.locationId.startsWith("LOC-")
      ? resolveLiveShortcode(db, data.locationId, "location")
      : Promise.resolve(data.locationId),
  ]);
  if (!rawProductId || !rawLocationId) {
    throw new Error("fixture: product/location not found");
  }
  const output = await createInventoryEntry(
    db,
    {
      ...data,
      productId: unsafeProductId(rawProductId),
      locationId: unsafeLocationId(rawLocationId),
    },
    actor,
  );
  const resolvedInventoryId = await resolveLiveShortcode(
    db,
    output.id,
    "inventory",
  );
  if (!resolvedInventoryId) throw new Error("fixture: inventory not found");
  return { ...output, entityId: unsafeInventoryId(resolvedInventoryId) };
};

/** An expense create input; every link (project/product/purchase) defaults to
 * unset so a test spells out only the relation it's asserting on. Passing
 * `vendor` still works and resolves into a real `Vendor` + `Purchase` — that
 * unchanged input shape is the point of the split. */
export const makeExpenseInput = (
  overrides: Partial<ExpenseCreateInput> = {},
): ExpenseCreateInput => ({
  name: "Test Expense",
  cost: 100,
  date: "2024-01-15",
  costType: "materials",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  projectId: null,
  productId: null,
  productQuantity: null,
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
  ingredientId: unsafeIngredientShortcode(id),
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

/** Public recipe graph plus its private UUID for repo/service test calls. */
export const createRecipeFixture = async (
  db: Database,
  input: RecipeCreateInput,
  actor: ActorContext,
) => {
  const output = await createRecipe(db, input, actor);
  const resolvedRecipeId = await resolveLiveShortcode(db, output.id, "recipe");
  if (!resolvedRecipeId) throw new Error("fixture: created recipe not found");
  return { ...output, entityId: unsafeRecipeId(resolvedRecipeId) };
};

/** Public meal output plus its private UUID for repo-only writes. */
export const createMealFixture = async (
  db: Database,
  input: MealCreateInput,
  actor: ActorContext,
) => {
  const output = await createMeal(db, input, actor);
  const resolvedMealId = await resolveLiveShortcode(db, output.id, "meal");
  if (!resolvedMealId) throw new Error("fixture: created meal not found");
  return { ...output, entityId: unsafeMealId(resolvedMealId) };
};

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
  const productInput = makeProductInput({
    name: `Test ${opts.name}`,
    manufacturer: "test",
    ingredientId: unsafeIngredientShortcode(ingredient.shortcode),
    unitMappings: [CUP_TO_GRAM],
  });
  const product = await createProduct(
    db,
    { ...productInput, ingredientId: ingredient.id },
    actor,
  );
  const [productId, locationId] = await Promise.all([
    resolveLiveShortcode(db, product.id, "product"),
    resolveLiveShortcode(db, location.id, "location"),
  ]);
  if (!productId || !locationId) {
    throw new Error("seed: created product/location could not be resolved");
  }
  await createInventoryEntry(
    db,
    {
      productId: unsafeProductId(productId),
      locationId: unsafeLocationId(locationId),
      amount: opts.onHand,
    },
    actor,
  );
  return ingredient;
};
