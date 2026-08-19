import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  cookbook,
  entityEmbedding,
  recipe,
  recipeSection,
} from "~/server/db/schema";
import {
  deleteCookbook,
  getCookbookByName,
  getCookbookSource,
  listCookbooks,
  reprocessCookbookStream,
  upsertCookbook,
} from "./cookbook";
import { getDb } from "./database-helpers";
import { findOrphanedEntityEmbeddings } from "./entity-embedding-cleanup";
import { upsertCookbookRecipeFromCookbook } from "./import-recipe-convert";
import { findPartiallyImportedCookbooks } from "./problems";
import { cookbookRecipe } from "./repo.fixtures";

// EPUB importer suite — actor audits as an epub import, not the UI.
describe("cookbook repository", () => {
  const ctx = withTestDb("epub_import");

  it("upsertCookbook creates then updates by name (no duplicate)", async () => {
    const raw = [cookbookRecipe("Pancakes", ["2 cups flour"])];
    const first = await upsertCookbook(
      ctx.db,
      { name: "Book A", rawJson: raw, author: ["Ada"], sourceLabel: "a.epub" },
      ctx.actor,
    );
    const second = await upsertCookbook(
      ctx.db,
      {
        name: "Book A",
        rawJson: raw,
        author: ["Ada", "Bob"],
        subjects: ["Baking"],
        sourceLabel: "a.epub",
      },
      ctx.actor,
    );

    expect(second.entityId).toBe(first.entityId);
    expect(second.output.id).toBe(first.output.id);
    const cb = await getCookbookByName(ctx.db, "Book A");
    expect(cb?.author).toEqual(["Ada", "Bob"]);
    expect(cb?.subjects).toEqual(["Baking"]);
    expect(cb?.rawJson).toHaveLength(1);
  });

  it("listCookbooks reports the live, non-deleted recipe count", async () => {
    const raw = [
      cookbookRecipe("Pancakes", ["2 cups flour"]),
      cookbookRecipe("Waffles", ["1 cup flour"]),
    ];
    const { output, entityId: id } = await upsertCookbook(
      ctx.db,
      { name: "Book A", rawJson: raw, sourceLabel: "a.epub" },
      ctx.actor,
    );
    const ref = { id, name: "Book A" };
    await upsertCookbookRecipeFromCookbook(raw[0]!, ref, ctx.db, ctx.actor);

    const list = await listCookbooks(ctx.db);
    const entry = list.find((c) => c.id === output.id);
    expect(entry).toBeDefined();
    // Only one of the two raw recipes was actually imported.
    expect(entry?.recipeCount).toBe(1);
    // sourceRecipeCount reflects the full stored extraction (both recipes).
    expect(entry?.sourceRecipeCount).toBe(2);
    // No cover uploaded in this test.
    expect(entry?.coverUrl).toBeNull();
  });

  it("finds cookbooks with source recipes missing from the live import relation", async () => {
    const raw = [
      cookbookRecipe("Pancakes", ["2 cups flour"]),
      cookbookRecipe("Waffles", ["1 cup flour"]),
    ];
    const { entityId: cookbookId, output } = await upsertCookbook(
      ctx.db,
      { name: "Partial Book", rawJson: raw, sourceLabel: "partial.epub" },
      ctx.actor,
    );
    const ref = { id: cookbookId, name: "Partial Book" };

    const initially = await findPartiallyImportedCookbooks(ctx.db);
    expect(initially).toContainEqual({
      id: output.id,
      name: "Partial Book",
      sourceRecipeCount: 2,
      recipeCount: 0,
      missingRecipeCount: 2,
    });

    const first = await upsertCookbookRecipeFromCookbook(
      raw[0]!,
      ref,
      ctx.db,
      ctx.actor,
    );
    const partlyImported = await findPartiallyImportedCookbooks(ctx.db);
    expect(partlyImported).toContainEqual({
      id: output.id,
      name: "Partial Book",
      sourceRecipeCount: 2,
      recipeCount: 1,
      missingRecipeCount: 1,
    });

    await upsertCookbookRecipeFromCookbook(raw[1]!, ref, ctx.db, ctx.actor);
    expect(await findPartiallyImportedCookbooks(ctx.db)).not.toContainEqual(
      expect.objectContaining({ id: output.id }),
    );

    await getDb(ctx.db)
      .update(recipe)
      .set({ deletedAt: new Date() })
      .where(eq(recipe.id, first.id));
    const afterSoftDelete = await findPartiallyImportedCookbooks(ctx.db);
    expect(afterSoftDelete).toContainEqual({
      id: output.id,
      name: "Partial Book",
      sourceRecipeCount: 2,
      recipeCount: 1,
      missingRecipeCount: 1,
    });
  });

  it("getCookbookSource returns the stored extraction for selective re-import", async () => {
    const raw = [
      cookbookRecipe("Pancakes", ["2 cups flour"]),
      cookbookRecipe("Waffles", ["1 cup flour"]),
    ];
    const { entityId: id } = await upsertCookbook(
      ctx.db,
      { name: "Book A", rawJson: raw, sourceLabel: "a.epub" },
      ctx.actor,
    );

    const src = await getCookbookSource(ctx.db, id);
    expect(src.id).toBe(id);
    expect(src.name).toBe("Book A");
    expect(src.recipes.map((r) => r.meta.title)).toEqual([
      "Pancakes",
      "Waffles",
    ]);
  });

  it("reprocessCookbook re-derives imported recipes and flags unimported extras", async () => {
    const raw = [
      cookbookRecipe("Pancakes", ["2 cups flour"]),
      cookbookRecipe("Waffles", ["1 cup flour"]),
    ];
    const { entityId: id } = await upsertCookbook(
      ctx.db,
      { name: "Book A", rawJson: raw, sourceLabel: "a.epub" },
      ctx.actor,
    );
    const ref = { id, name: "Book A" };

    // Import only the first recipe (the user's selection).
    const imported = await upsertCookbookRecipeFromCookbook(
      raw[0]!,
      ref,
      ctx.db,
      ctx.actor,
    );

    // Drain the streaming generator: collect progress events, read the summary.
    const gen = reprocessCookbookStream(ctx.db, id, ctx.actor);
    const events: { done: number; total: number }[] = [];
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    const result = next.value;

    // One progress tick for the single reprocessed recipe (extras aren't counted).
    expect(events).toEqual([{ done: 1, total: 1, recipeId: imported.id }]);

    // Pancakes was re-derived; Waffles (never imported) is surfaced, not created.
    expect(result.reprocessed).toBe(1);
    expect(result.importableExtras).toEqual(["Waffles"]);

    // Reprocess upserts in place — no duplicate, same id.
    const pancakes = await getDb(ctx.db).query.recipe.findMany({
      where: eq(recipe.name, "Pancakes"),
    });
    expect(pancakes).toHaveLength(1);
    expect(pancakes[0]!.id).toBe(imported.id);
    expect(pancakes[0]!.cookbookId).toBe(id);

    // Waffles stayed unimported.
    const waffles = await getDb(ctx.db).query.recipe.findMany({
      where: eq(recipe.name, "Waffles"),
    });
    expect(waffles).toHaveLength(0);
  });

  // deleteCookbook is UNGUARDED (lockAndValidateForDelete only locks + checks
  // existence — no assertNoDependents call for sub-recipe usage or meal-plan
  // membership), so it cascades to every imported recipe unconditionally. This
  // guards the removal-path invariant from root CLAUDE.md: the cascade must
  // reach sections/ingredients AND leave no live EntityEmbedding row for
  // either the cookbook or its recipes (mirrors
  // embedding-cascade-invariant.integration.test.ts's per-entity coverage,
  // which only asserts the Cookbook row's own embedding — this exercises the
  // recipe cascade underneath it too).
  it("deleteCookbook soft-deletes the book, its recipes, sections, ingredients, and leaves no embedding orphans", async () => {
    const raw = [cookbookRecipe("Pancakes", ["2 cups flour"])];
    const { entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      { name: "Book A", rawJson: raw, sourceLabel: "a.epub" },
      ctx.actor,
    );
    const ref = { id: cookbookId, name: "Book A" };
    const { id: recipeId } = await upsertCookbookRecipeFromCookbook(
      raw[0]!,
      ref,
      ctx.db,
      ctx.actor,
    );

    const sectionsBefore = await getDb(ctx.db).query.recipeSection.findMany({
      where: eq(recipeSection.recipeId, recipeId),
    });
    expect(sectionsBefore.length).toBeGreaterThan(0);
    const sectionIds = sectionsBefore.map((s) => s.id);
    const ingredientsBefore = await getDb(
      ctx.db,
    ).query.recipeSectionIngredient.findMany({
      where: (t, { inArray }) => inArray(t.recipeSectionId, sectionIds),
    });
    expect(ingredientsBefore.length).toBeGreaterThan(0);

    // Seed a live search-embedding row for both the cookbook and its recipe —
    // a minimal 3-dim vector inserts fine (the HNSW index is partial on
    // dimensions=1536).
    const seedEmbedding = (
      entityType: "cookbook" | "recipe",
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
    await seedEmbedding("cookbook", cookbookId);
    await seedEmbedding("recipe", recipeId);

    const { deletedRecipeIds } = await deleteCookbook(
      ctx.db,
      cookbookId,
      ctx.actor,
    );
    expect(deletedRecipeIds).toEqual([recipeId]);

    const cookbookRow = await getDb(ctx.db).query.cookbook.findFirst({
      where: eq(cookbook.id, cookbookId),
    });
    expect(cookbookRow?.deletedAt).not.toBeNull();

    const recipeRow = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.id, recipeId),
    });
    expect(recipeRow?.deletedAt).not.toBeNull();

    const sectionsAfter = await getDb(ctx.db).query.recipeSection.findMany({
      where: eq(recipeSection.recipeId, recipeId),
    });
    expect(sectionsAfter.every((s) => s.deletedAt !== null)).toBe(true);

    const ingredientsAfter = await getDb(
      ctx.db,
    ).query.recipeSectionIngredient.findMany({
      where: (t, { inArray }) => inArray(t.recipeSectionId, sectionIds),
    });
    expect(ingredientsAfter.every((i) => i.deletedAt !== null)).toBe(true);

    const cookbookEmbedding = await getDb(
      ctx.db,
    ).query.entityEmbedding.findFirst({
      where: and(
        eq(entityEmbedding.entityType, "cookbook"),
        eq(entityEmbedding.entityId, cookbookId),
      ),
    });
    expect(cookbookEmbedding?.deletedAt).not.toBeNull();

    const recipeEmbedding = await getDb(ctx.db).query.entityEmbedding.findFirst(
      {
        where: and(
          eq(entityEmbedding.entityType, "recipe"),
          eq(entityEmbedding.entityId, recipeId),
        ),
      },
    );
    expect(recipeEmbedding?.deletedAt).not.toBeNull();

    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });
});
