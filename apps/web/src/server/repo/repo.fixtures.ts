import type { ActorContext } from "@cubby/schemas/context";
import type {
  CookbookExtraction,
  CookbookRecipe,
} from "@cubby/schemas/cookbook";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  type EntityId,
  type IngredientId,
  type ProductCategoryId,
  type ProductCategoryShortcode,
  type IngredientShortcode,
  type PlantId,
  type PlantShortcode,
  type RecipeId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import {
  type LocationCreateInput,
  locationCreateInput,
} from "@cubby/schemas/location";
import type { PlantCreateInput } from "@cubby/schemas/plant";
import type { ProductCreateInput } from "@cubby/schemas/product";
import type { ExpenseCreateInput } from "@cubby/schemas/project";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import type { RecipeTotals } from "@cubby/schemas/recipe-shared";
import type { SearchableEntity } from "@cubby/schemas/search";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import { wasm } from "~/lib/wasm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { type image, product, recipe } from "~/server/db/schema";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { getDb } from "./database-helpers";
import type { CookbookImportContext } from "./import-recipe-convert";
import { createIngredient, findOrCreateIngredient } from "./ingredient";
import { createInventoryEntry } from "./inventory";
import { createLocation } from "./location";
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
  GrowsPlant extends PlantId | PlantShortcode | null | undefined,
  Category extends
    | ProductCategoryId
    | ProductCategoryShortcode
    | null
    | undefined,
> = Omit<ProductCreateInput, "ingredientId" | "growsPlantId" | "categoryId"> & {
  ingredientId: Ingredient | null;
  growsPlantId: GrowsPlant | null;
  categoryId: Category | null;
};

/**
 * A product create input with sensible defaults; override what the test cares
 * about. The ingredient brand is preserved so the same test-only builder can
 * seed the UUID-only repo boundary or exercise the shortcode-only router.
 */
export const makeProductInput = <
  Ingredient extends IngredientId | IngredientShortcode | null | undefined =
    undefined,
  GrowsPlant extends PlantId | PlantShortcode | null | undefined = undefined,
  Category extends
    | ProductCategoryId
    | ProductCategoryShortcode
    | null
    | undefined = undefined,
>(
  overrides: Omit<
    Partial<ProductCreateInput>,
    "ingredientId" | "growsPlantId" | "categoryId"
  > & {
    ingredientId?: Ingredient;
    growsPlantId?: GrowsPlant;
    categoryId?: Category;
  } = {},
): ProductFixtureInput<Ingredient, GrowsPlant, Category> => {
  const { ingredientId, growsPlantId, categoryId, ...rest } = overrides;
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
    growsPlantId: growsPlantId ?? null,
    categoryId: categoryId ?? null,
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
  const growsPlantId = data.growsPlantId
    ? await resolveLiveShortcode(db, data.growsPlantId, "plant")
    : null;
  if (data.growsPlantId && !growsPlantId) {
    throw new Error(`fixture: growing plant ${data.growsPlantId} not found`);
  }
  return createProduct(
    db,
    {
      ...data,
      categoryId: data.categoryId
        ? await resolveLiveShortcode(db, data.categoryId, "productCategory")
        : null,
      growsPlantId: growsPlantId ? parseEntityId("plant", growsPlantId) : null,
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

/**
 * Mint code-less deleted `Entity` identities: the tombstone a hard-deleted
 * payload leaves, and the only identity a projection row may name without a
 * backing payload row (`SearchDocument_entity_fk`, `EntityEmbedding_entity_fk`).
 */
export const seedEntityTombstonesFixtureRaw = async (
  db: Database,
  kind: SearchableEntity,
  count: number,
): Promise<string[]> => {
  const result = await getDb(db).execute<{ id: string }>(sql`
    INSERT INTO "Entity" (id, kind, "deletedAt")
    SELECT gen_random_uuid(), ${kind}, now()
    FROM generate_series(1, ${count})
    RETURNING id
  `);
  return result.rows.map((row) => row.id);
};

/**
 * Seed N live `SearchDocument` rows with no backing payload row; each names a
 * tombstone identity.
 *
 * The embedding backfill coordinator's contract is over document PAGES, so a
 * test about how one page is divided needs documents, not entities — building
 * 250 real products to assert an arithmetic split would cost minutes.
 */
export const seedSearchDocumentsFixtureRaw = async (
  db: Database,
  entityType: SearchableEntity,
  count: number,
): Promise<void> => {
  await getDb(db).execute(sql`
    WITH identity AS (
      INSERT INTO "Entity" (id, kind, "deletedAt")
      SELECT gen_random_uuid(), ${entityType}, now()
      FROM generate_series(1, ${count})
      RETURNING id
    ), numbered AS (
      SELECT id, row_number() OVER (ORDER BY id) AS i FROM identity
    )
    INSERT INTO "SearchDocument" (
      "entityType", "entityId", "shortcode", title, body,
      "semanticText", "normalizedText", "searchVector", "sourceHash"
    )
    SELECT ${entityType}, id, 'SEED-' || i,
      'Seed fixture ' || i, 'Seed fixture body ' || i,
      'Seed fixture body ' || i, 'seed fixture body ' || i,
      to_tsvector('simple', 'seed fixture ' || i), 'seed-fixture-' || i
    FROM numbered
  `);
};

/** Model the coordinated cache cutover without invoking authored-row update hooks. */
export const setRecipeTotalsFixtureRaw = async (
  db: Database,
  id: RecipeId,
  totals: RecipeTotals | null,
  computedAt: Date | null,
): Promise<void> => {
  await getDb(db).execute(sql`UPDATE ${recipe}
    SET "totals" = ${totals == null ? null : JSON.stringify(totals)}::jsonb,
        "totalsComputedAt" = ${computedAt}
    WHERE ${recipe.id} = ${id}`);
};

export const createIngredientFixture = retainEntityId(
  "ingredient",
  createIngredient,
);

export const createLocationFixture = retainEntityId("location", createLocation);

/** A Plant with every optional field null; override what the test cares about. */
export const createPlantFixture = async (
  db: Database,
  data: Partial<PlantCreateInput> & { name: string },
  actor: ActorContext,
) =>
  // Dynamic: a static import pulls `repo/plant`'s removal/merge chain in
  // ahead of `data-quality`, and module init then hits a half-built cycle.
  (
    await (
      await import("./plant")
    ).createPlant(
      db,
      {
        gardenGuideKey: null,
        verdict: null,
        ingredientId: null,
        latinName: null,
        breeding: null,
        daysFromSowMin: null,
        daysFromSowMax: null,
        daysFromTransplantMin: null,
        daysFromTransplantMax: null,
        notes: null,
        ...data,
      },
      actor,
    )
  ).output;

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
): ExpenseCreateInput => {
  const input: ExpenseCreateInput = {
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
  };
  return input;
};

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
): RecipeIngredientInput => {
  const input: RecipeIngredientInput = {
    type: "ingredient",
    ingredientId: parseShortcodeFor("ingredient", id),
    recipeId: null,
    amounts: opts.amounts ?? [{ value: 1, unit: "cup" }],
  };
  if (opts.modifier !== undefined) input.modifier = opts.modifier;
  if (opts.rawLine !== undefined) input.rawLine = opts.rawLine;
  return input;
};

export const makeRecipeInput = (
  opts: {
    name?: string;
    url?: string | null;
    sections?: RecipeCreateInput["sections"];
    tags?: RecipeCreateInput["tags"];
  } = {},
): RecipeCreateInput => {
  const input: RecipeCreateInput = {
    name: opts.name ?? "Test Recipe",
    meta: { url: opts.url ?? null },
    sections: opts.sections ?? [],
  };
  // Passed through only when the caller opts in, so the default stays a
  // tags-absent input rather than an explicit null.
  if ("tags" in opts) input.tags = opts.tags;
  return input;
};

export const createRecipeFixture = retainEntityId("recipe", createRecipe);

// A fixture ingredient line: bare text, or text with a reference to another
// item by id. Parsed rather than type-tested, per the repo's lint rules.
const cookbookFixtureLine = z.union([
  z.string().transform((line) => ({ line, ref: undefined })),
  z.object({ line: z.string(), ref: z.string() }),
]);

/**
 * A recipe item as the `cookbook` crate emits it: every ingredient line
 * already parsed (through the same wasm parser), an optional `ref` to another
 * item by id, photos as archive paths. Ids follow the crate's
 * `{doc:03}.{line:04}` form; callers pick them so edges can point at them.
 */
export const makeCookbookRecipe = (
  name: string,
  ingredients: readonly (string | { line: string; ref: string })[],
  overrides: {
    id?: string;
    steps?: readonly string[];
    photos?: readonly { path: string; mime: string; alt?: string }[];
    description?: readonly string[];
    recipeYield?: string;
    variantOf?: string;
    section?: string;
  } = {},
): CookbookRecipe => {
  const id =
    overrides.id ?? `001.${String(nextCookbookLine++).padStart(4, "0")}`;
  const lines = ingredients.map((entry) => cookbookFixtureLine.parse(entry));
  const parsed = wasm.parse_ingredient_lines(lines.map((l) => l.line));
  return {
    kind: "recipe",
    id,
    title: name,
    name,
    meta: {
      description: [...(overrides.description ?? [])],
      recipe_yield: overrides.recipeYield ?? null,
      times: null,
      equipment: [],
      category: null,
      page: null,
    },
    sections: [
      {
        name: overrides.section ?? null,
        ingredients: lines.map((entry, i) => ({
          raw: entry.line,
          line: i,
          parsed: {
            name: parsed[i]!.name,
            amounts: parsed[i]!.amounts.map((a) => ({
              unit: a.unit,
              value: a.value,
              upper_value: a.upper_value ?? null,
            })),
            modifier: parsed[i]!.modifier ?? null,
            optional: parsed[i]!.optional ?? false,
          },
          confidence: "high",
          ref: entry.ref
            ? {
                target_id: entry.ref,
                text: entry.line,
                kind: "ingredient",
                method: "title",
              }
            : null,
        })),
        steps: (overrides.steps ?? []).map((text, i) => ({
          text,
          line: 100 + i,
          refs: [],
        })),
      },
    ],
    photos: (overrides.photos ?? []).map((photo) => ({
      path: photo.path,
      mime: photo.mime,
      alt: photo.alt ?? null,
      caption: null,
      line: null,
    })),
    notes: [],
    variant_of: overrides.variantOf ?? null,
    span: { start: 0, end: 1, doc_path: "OEBPS/c01.xhtml", page: null },
  };
};
let nextCookbookLine = 1;

/** A stored book tree with one chapter holding `recipes`, plus ingredient edges. */
export const makeCookbookExtraction = (
  recipes: readonly CookbookRecipe[] = [],
  overrides: { title?: string; chapter?: string | null } = {},
): CookbookExtraction => ({
  contract: "cookbook-indexed-v1",
  source: {
    label: `${overrides.title ?? "Test Book"}.epub`,
    sha256: "0".repeat(64),
    title: overrides.title ?? "Test Book",
    authors: [],
    identifiers: [],
    subjects: [],
  },
  cover: null,
  chapters: [
    {
      id: "ch01",
      title: overrides.chapter === undefined ? "Recipes" : overrides.chapter,
      items: [...recipes],
    },
  ],
  edges: recipes.flatMap((r) =>
    r.sections.flatMap((s) =>
      s.ingredients.flatMap((line) =>
        line.ref
          ? [
              {
                from: r.id,
                to: line.ref.target_id,
                kind: line.ref.kind,
                method: line.ref.method,
              },
            ]
          : [],
      ),
    ),
  ),
});

/** The context the import loop threads through `upsertCookbookRecipeFromCookbook`. */
export const makeCookbookImportContext = (
  extraction: CookbookExtraction,
): CookbookImportContext => ({
  titleToId: new Map(),
  extraction,
  ingredientIdByName: new Map(),
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
