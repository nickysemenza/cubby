import type { ActorContext } from "@cubby/schemas/context";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  type EntityId,
  type IngredientId,
  type IngredientShortcode,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import {
  type LocationCreateInput,
  locationCreateInput,
} from "@cubby/schemas/location";
import type { ProductCreateInput } from "@cubby/schemas/product";
import type { ExpenseCreateInput } from "@cubby/schemas/project";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { eq } from "drizzle-orm";

import { mock } from "~/lib/test/mock-schema";
import type { Database, DrizzleTransaction } from "~/server/db";
import { type image, product } from "~/server/db/schema";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { getDb } from "./database-helpers";
import { createIngredient, findOrCreateIngredient } from "./ingredient";
import { createInventoryEntry } from "./inventory";
import { createLocation } from "./location";
import { createMeal } from "./meal";
import { createProduct } from "./product";
import { createRecipe } from "./recipe";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { insertWithShortcode } from "./shortcode-utils";

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
  ingredientId: Ingredient | null;
};

/**
 * A product create input with sensible defaults; override what the test cares
 * about. The ingredient brand is preserved so the same test-only builder can
 * seed the UUID-only repo boundary or exercise the shortcode-only router.
 */
export const makeProductInput = <
  Ingredient extends IngredientId | IngredientShortcode | null | undefined =
    undefined,
>(
  overrides: Omit<Partial<ProductCreateInput>, "ingredientId"> & {
    ingredientId?: Ingredient;
  } = {},
): ProductFixtureInput<Ingredient> => {
  const { ingredientId, ...rest } = overrides;
  return {
    name: "Test Product",
    aliases: [],
    tags: [],
    manufacturer: "Test Manufacturer",
    model: "TEST-123",
    upc: null,
    fdc_id: null,
    expectedQuantity: null,
    ingredientId: ingredientId ?? null,
    unitMappings: [],
    externalIds: [],
    ...rest,
  };
};

/**
 * Wraps `createX(db, data, actor)` with the create → resolve → throw → brand
 * tail every fixture below repeated: re-resolve the shortcode into its live
 * uuid and attach it as `entityId`, for callers (e.g. `createInventoryEntry`)
 * that take UUID-only branded ids. `createFn` may return `null` (as
 * `createLocation` does) — treated the same as a resolve failure.
 */
const retainEntityId =
  <
    E extends ShortcodeEntity,
    TOut extends { id: string },
    TArgs extends [Database | DrizzleTransaction, ...unknown[]],
  >(
    entity: E,
    createFn: (...args: TArgs) => Promise<TOut | null | undefined>,
  ) =>
  async (...args: TArgs): Promise<TOut & { entityId: EntityId<E> }> => {
    const [db] = args;
    const output = await createFn(...args);
    if (!output) throw new Error(`fixture: ${entity} not created`);
    const resolvedId = await resolveLiveShortcode(db, output.id, entity);
    if (!resolvedId) throw new Error(`fixture: created ${entity} not found`);
    return { ...output, entityId: parseEntityId(entity, resolvedId) };
  };

/** Resolves a public ingredient id before handing off to `createProduct`. */
const createProductWithResolvedIngredient = async (
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
  return createProduct(
    db,
    {
      ...data,
      ingredientId: resolvedIngredientId
        ? parseEntityId("ingredient", resolvedIngredientId)
        : null,
    },
    actor,
  );
};

/**
 * Create a product for a repo integration test while retaining both sides of
 * the boundary. Public assertions use `id`; UUID-only repo writes use
 * `entityId`. A public ingredient id is resolved here so callers never cast a
 * shortcode into a FK brand.
 */
export const createProductFixture = retainEntityId(
  "product",
  createProductWithResolvedIngredient,
);

/** Simulate an out-of-band source edit without running mutation side effects. */
export const updateProductNameFixtureRaw = async (
  db: Database,
  productId: string,
  name: string,
): Promise<void> => {
  await getDb(db)
    .update(product)
    .set({ name })
    .where(eq(product.id, parseEntityId("product", productId)));
};

export const createIngredientFixture = retainEntityId(
  "ingredient",
  createIngredient,
);

export const createLocationFixture = retainEntityId("location", createLocation);

/** Resolves canonical public product/location ids before `createInventoryEntry`. */
const createInventoryWithResolvedIds = async (
  db: Database,
  data: {
    productId: string;
    locationId: string;
    amount: Amount;
    verifiedAt?: Date | null;
    /** Defaults to `stock`; pass `installed` to exercise a fixture row. */
    placement?: InventoryPlacement;
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
  return createInventoryEntry(
    db,
    {
      ...data,
      productId: parseEntityId("product", rawProductId),
      locationId: parseEntityId("location", rawLocationId),
    },
    actor,
  );
};

/**
 * Create inventory from canonical public product/location ids and retain the
 * private row id for direct repo reads and reconciliation fixtures.
 */
export const createInventoryFixture = retainEntityId(
  "inventory",
  createInventoryWithResolvedIds,
);

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
  lineBasis: "item_line",
  costType: "materials",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  beneficiaries: [],
  funders: [],
  sourceClaims: [],
  projectId: null,
  productId: null,
  productQuantity: null,
  purchaseId: null,
  vendor: null,
  orderId: null,
  ...overrides,
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

export const ingredientRef = (
  id: string,
  opts: { amounts?: Amount[]; modifier?: string; rawLine?: string } = {},
): RecipeIngredientInput => ({
  type: "ingredient" as const,
  ingredientId: parseShortcodeFor("ingredient", id),
  recipeId: null,
  amounts: opts.amounts ?? [{ value: 1, unit: "cup" }],
  ...(opts.modifier !== undefined ? { modifier: opts.modifier } : {}),
  ...(opts.rawLine !== undefined ? { rawLine: opts.rawLine } : {}),
});

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

export const createRecipeFixture = retainEntityId("recipe", createRecipe);

export const createMealFixture = retainEntityId("meal", createMeal);

export const makeImportRecipe = (
  overrides: Partial<ImportRecipe> = {},
): ImportRecipe => ({
  meta: { title: "Test Recipe" },
  sections: [{ instructions: [], ingredients: [] }],
  references: [],
  ...overrides,
});

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
    ingredientId: parseShortcodeFor("ingredient", ingredient.shortcode),
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
      productId: parseEntityId("product", productId),
      locationId: parseEntityId("location", locationId),
      amount: opts.onHand,
    },
    actor,
  );
  return ingredient;
};

/**
 * An uploaded Image row ready to attach via `pendingImageIds`.
 *
 * Lives here rather than in the test so a `services/` test can reach it: that
 * layer is barred from importing schema or database-helpers directly, and this
 * is the repo-side seam that rule expects fixtures to use.
 *
 * `overrides` is how a test asks for an UNdisplayable file — a PDF manual, a
 * `renderStatus: "failed"` render, an object missing from R2.
 */
export const createImageFixture = async (
  db: Database,
  name: string,
  overrides: Partial<Omit<typeof image.$inferInsert, "shortcode">> = {},
) => {
  const row = await insertWithShortcode(db, "image", {
    key: `fixture-${name}`,
    filename: `${name}.png`,
    contentType: "image/png",
    size: 100,
    status: "UPLOADED",
    ...overrides,
  });
  return { ...row, url: getR2PublicUrl(row.key) };
};
