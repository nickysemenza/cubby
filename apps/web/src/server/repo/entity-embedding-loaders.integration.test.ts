import {
  projectCreateInput,
  purchaseCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import {
  type SearchableEntity,
  searchableEntities,
} from "@cubby/schemas/search";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { entityEmbedding } from "~/server/db/schema";
import { getDb } from "./database-helpers";
import {
  findOrphanedEntityEmbeddings,
  getEmbeddingTextForEntity,
  getEmbeddingTextsForEntityTypes,
} from "./entity-embedding";
import { createIngredient } from "./ingredient";
import { createInventoryEntry } from "./inventory";
import { createLocation } from "./location";
import { createProduct } from "./product";
import { createProject } from "./project";
import { createPurchase } from "./purchase";
import { createRecipe } from "./recipe";
import {
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { createTask } from "./task";

describe("searchable entity loader maps", () => {
  const ctx = withTestDb();

  it("uses the same batch and single loaders for every searchable entity", async () => {
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Loader ingredient", aliases: ["loader alias"] },
      ctx.actor,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Loader product",
        ingredientId: ingredient.id,
      }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Loader pantry" }),
      ctx.actor,
    );
    const inventory = await createInventoryEntry(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Loader recipe" }),
      ctx.actor,
    );
    const project = await createProject(
      ctx.db,
      mock(projectCreateInput, { overrides: { name: "Loader project" } }),
      ctx.actor,
    );
    const task = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: { name: "Loader task", projectId: project.id },
      }),
      ctx.actor,
    );
    const purchase = await createPurchase(
      ctx.db,
      mock(purchaseCreateInput, {
        overrides: { name: "Loader purchase", projectId: project.id },
      }),
      ctx.actor,
    );
    const ids = {
      product: product.id,
      recipe: recipe.id,
      ingredient: ingredient.id,
      location: location.id,
      inventory: inventory.id,
      project: project.id,
      task: task.id,
      purchase: purchase.id,
    } satisfies Record<SearchableEntity, string>;

    const batch = await getEmbeddingTextsForEntityTypes(ctx.db, [
      ...searchableEntities,
    ]);
    const byRef = new Map(
      batch.map((row) => [`${row.entityType}:${row.entityId}`, row]),
    );

    for (const entityType of searchableEntities) {
      const single = await getEmbeddingTextForEntity(
        ctx.db,
        entityType,
        ids[entityType],
      );
      expect(single).toEqual(byRef.get(`${entityType}:${ids[entityType]}`));
      expect(single?.embeddingText).toContain("Loader");
    }
  });

  it("checks live IDs through every orphan loader", async () => {
    const refs = searchableEntities.map((entityType, index) => ({
      entityType,
      entityId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    await getDb(ctx.db)
      .insert(entityEmbedding)
      .values(
        refs.map((ref) => ({
          ...ref,
          embeddingText: `orphan ${ref.entityType}`,
          embeddingHash: `orphan-${ref.entityType}`,
          provider: "test",
          model: "test",
          dimensions: 3,
          embedding: [0, 0, 0],
        })),
      );

    const orphaned = await findOrphanedEntityEmbeddings(ctx.db);
    expect(orphaned.map(({ entityType }) => entityType).sort()).toEqual(
      [...searchableEntities].sort(),
    );
  });
});
