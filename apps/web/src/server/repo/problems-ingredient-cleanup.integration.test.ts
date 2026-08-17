import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { viewProblemDeclarations } from "~/entities/view-manifest";
import { entityEmbedding, ingredient } from "~/server/db/schema";
import { deleteUnusedIngredients } from "../services/problems.service";
import { getDb } from "./database-helpers";
import { upsertImportRecipe } from "./import-recipe-convert";
import { findOrCreateIngredient, ingredientList } from "./ingredient";
import { findIngredientsWithUnusedAliases } from "./problems";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeImportRecipe,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import { generateUniqueShortcode } from "./shortcode-utils";

/**
 * The unused-ingredient split, resolved the way the app now resolves it: through
 * the two saved views' own declared filters.
 *
 * Reading `serverFilters` from the manifest rather than restating the predicate
 * is what makes this a parity gate — it's the assertion that let
 * `findUnusedIngredients` be deleted, and it keeps failing if the views drift.
 */
const unusedIngredients = async (db: Parameters<typeof ingredientList>[0]) => {
  const bySection = async (key: string) => {
    const declaration = viewProblemDeclarations().find(
      (candidate) => candidate.problem.key === key,
    );
    if (!declaration) throw new Error(`no view declares ${key}`);
    const { data } = await ingredientList(
      db,
      declaration.problem.serverFilters as never,
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    return data.map((row) => ({ ...row, products: row.product }));
  };
  return {
    withProduct: await bySection("unusedIngredientsWithProduct"),
    withoutProduct: await bySection("unusedIngredientsWithoutProduct"),
  };
};

describe("unused ingredients (saved-view backed)", () => {
  const ctx = withTestDb();

  it("splits unused ingredients by product link, excluding in-recipe and sub-recipe ones", async () => {
    // In-recipe ingredient → never "unused".
    await upsertImportRecipe(
      makeImportRecipe({
        meta: { title: "soup" },
        sections: [{ instructions: ["stir"], ingredients: ["carrot"] }],
      }),
      ctx.db,
      ctx.actor,
    );

    // Unused, no product.
    await findOrCreateIngredient(ctx.db, "lonely spice");

    // Unused, linked to a product (no inventory).
    const withProd = await findOrCreateIngredient(ctx.db, "boxed thing");
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Boxed", ingredientId: withProd.id }),
      ctx.actor,
    );

    // Sub-recipe pointer (recipeId set) → excluded even with no usage/product.
    const recipe = await upsertImportRecipe(
      makeImportRecipe({ meta: { title: "sub" } }),
      ctx.db,
      ctx.actor,
    );
    await getDb(ctx.db)
      .insert(ingredient)
      .values({
        name: "Recipe: sub",
        recipeId: recipe.id,
        shortcode: await generateUniqueShortcode(ctx.db, "ingredient"),
      });

    const { withProduct, withoutProduct } = await unusedIngredients(ctx.db);

    expect(withoutProduct.map((i) => i.name)).toEqual(["lonely spice"]);
    expect(withProduct.map((i) => i.name)).toEqual(["boxed thing"]);
    expect(withProduct[0]?.products.map((p) => p.name)).toEqual(["Boxed"]);
    // carrot (in-recipe) and "Recipe: sub" (pointer) are absent from both.
    const allNames = [...withProduct, ...withoutProduct].map((i) => i.name);
    expect(allNames).not.toContain("carrot");
    expect(allNames).not.toContain("Recipe: sub");
  });
});

describe("findIngredientsWithUnusedAliases", () => {
  const ctx = withTestDb();

  it("flags redundant and never-matched aliases, not recipe-matched ones", async () => {
    // "scallion" is used by a recipe line and resolves to this ingredient, so
    // the alias "scallion" is matched (kept); "bogus" never appears (flagged).
    await findOrCreateIngredient(ctx.db, "green onion", ["scallion", "bogus"]);
    await upsertImportRecipe(
      makeImportRecipe({
        meta: { title: "stirfry" },
        sections: [{ instructions: ["chop"], ingredients: ["scallion"] }],
      }),
      ctx.db,
      ctx.actor,
    );

    const flagged = await findIngredientsWithUnusedAliases(ctx.db);
    const row = flagged.find((f) => f.name === "green onion");
    expect(row).toBeDefined();
    expect(row?.unusedAliases).toEqual(["bogus"]);
    expect(row?.unusedAliases).not.toContain("scallion");
  });
});

describe("deleteUnusedIngredients", () => {
  const ctx = withTestDb();

  // Seed a search-embedding row for an entity (minimal valid vector).
  const seedEmbedding = async (
    entityType: SearchableEntity,
    entityId: string,
  ) =>
    getDb(ctx.db)
      .insert(entityEmbedding)
      .values({
        entityType,
        entityId,
        embeddingText: `${entityType} ${entityId}`,
        embeddingHash: `hash-${entityId}`,
        provider: "test",
        model: "test",
        dimensions: 3,
        embedding: [0, 0, 0],
      });

  const liveEmbedding = async (
    entityType: SearchableEntity,
    entityId: string,
  ) =>
    getDb(ctx.db).query.entityEmbedding.findFirst({
      where: and(
        eq(entityEmbedding.entityType, entityType),
        eq(entityEmbedding.entityId, entityId),
      ),
      columns: { deletedAt: true },
    });

  it("reports failure (not throw) when a linked product still has inventory", async () => {
    const ing = await findOrCreateIngredient(ctx.db, "stocked ingredient");
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Pantry" }),
      ctx.actor,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Stocked", ingredientId: ing.id }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    const result = await deleteUnusedIngredients(
      ctx.db,
      [ing.id],
      true,
      ctx.actor,
    );
    expect(result.deleted).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe(ing.id);

    // The ingredient survives the failed delete.
    const stillThere = await getDb(ctx.db).query.ingredient.findFirst({
      where: eq(ingredient.id, ing.id),
    });
    expect(stillThere?.deletedAt).toBeNull();
  });

  it("deletes the ingredient and its product when there's no inventory", async () => {
    const ing = await findOrCreateIngredient(ctx.db, "deletable ingredient");
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Deletable", ingredientId: ing.id }),
      ctx.actor,
    );

    const result = await deleteUnusedIngredients(
      ctx.db,
      [ing.id],
      true,
      ctx.actor,
    );
    expect(result.deleted).toBe(1);
    expect(result.failed).toHaveLength(0);

    const gone = await getDb(ctx.db).query.ingredient.findFirst({
      where: eq(ingredient.id, ing.id),
    });
    expect(gone?.deletedAt).not.toBeNull();

    // No unused product-linked ingredient remains.
    const { withProduct } = await unusedIngredients(ctx.db);
    expect(withProduct.map((i) => i.name)).not.toContain(
      "deletable ingredient",
    );
  });

  // Regression: deleteUnusedIngredients calls the repo deleteProducts/
  // deleteIngredients directly, bypassing runMutationSideEffects. The embedding
  // soft-delete therefore has to live in the repo delete cascade — otherwise
  // this path orphans the entity's search-embedding row (an entityEmbedding
  // whose entity no longer exists), which is what the Problems page flags.
  it("soft-deletes the entity embeddings too (no orphans left behind)", async () => {
    const ing = await findOrCreateIngredient(ctx.db, "embedded ingredient");
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Embedded", ingredientId: ing.id }),
      ctx.actor,
    );
    await seedEmbedding("ingredient", ing.id);
    await seedEmbedding("product", product.entityId);

    const result = await deleteUnusedIngredients(
      ctx.db,
      [ing.id],
      true,
      ctx.actor,
    );
    expect(result.deleted).toBe(1);

    expect(
      (await liveEmbedding("ingredient", ing.id))?.deletedAt,
    ).not.toBeNull();
    expect(
      (await liveEmbedding("product", product.entityId))?.deletedAt,
    ).not.toBeNull();
  });
});
