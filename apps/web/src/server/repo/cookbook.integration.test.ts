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
  getCookbookRecipePhotoSource,
  listCookbooks,
  setCookbookProduct,
  upsertCookbook,
} from "./cookbook";
import { getDb } from "./database-helpers";
import { findOrphanedEntityEmbeddings } from "./entity-embedding-cleanup";
import { createPendingImageRecord } from "./image";
import { upsertCookbookRecipeFromCookbook } from "./import-recipe-convert";
import { deleteProducts } from "./product";
import {
  cookbookRecipe,
  createProductFixture,
  makeProductInput,
} from "./repo.fixtures";

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

  it("preserves an existing cover and leaves a redundant re-import cover pending", async () => {
    const firstCover = await createPendingImageRecord(ctx.db, {
      key: "covers/first.jpg",
      filename: "first.jpg",
      contentType: "image/jpeg",
      size: 100,
    });
    const redundantCover = await createPendingImageRecord(ctx.db, {
      key: "covers/redundant.jpg",
      filename: "redundant.jpg",
      contentType: "image/jpeg",
      size: 100,
    });
    const first = await upsertCookbook(
      ctx.db,
      {
        name: "Covered Book",
        rawJson: [],
        sourceLabel: "covered.epub",
        coverImageId: firstCover.id,
      },
      ctx.actor,
    );
    await upsertCookbook(
      ctx.db,
      {
        name: "Covered Book",
        rawJson: [],
        sourceLabel: "covered-again.epub",
        coverImageId: redundantCover.id,
      },
      ctx.actor,
    );

    const row = await getDb(ctx.db).query.cookbook.findFirst({
      where: eq(cookbook.id, first.entityId),
      columns: { coverImageId: true },
    });
    const covers = await getDb(ctx.db).query.image.findMany({
      where: (table, { inArray }) =>
        inArray(table.id, [firstCover.id, redundantCover.id]),
      columns: { id: true, status: true },
    });
    expect(row?.coverImageId).toBe(firstCover.id);
    expect(covers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstCover.id, status: "UPLOADED" }),
        expect.objectContaining({ id: redundantCover.id, status: "PENDING" }),
      ]),
    );
  });

  it("authorizes an EPUB photo by live cookbook, source index, recipe membership, and title", async () => {
    const raw = [
      cookbookRecipe("Pancakes", ["2 cups flour"], {
        image: {
          kind: "epub",
          path: "OEBPS/images/pancakes.jpg",
          mime: "image/jpeg",
          alt: "Pancakes",
        },
      }),
    ];
    const { entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      { name: "Book A", rawJson: raw, sourceLabel: "a.epub" },
      ctx.actor,
    );
    const imported = await upsertCookbookRecipeFromCookbook(
      raw[0]!,
      { id: cookbookId, name: "Book A" },
      ctx.db,
      ctx.actor,
    );

    await expect(
      getCookbookRecipePhotoSource(ctx.db, cookbookId, imported.id, 0),
    ).resolves.toEqual(raw[0]!.image);

    const other = await upsertCookbook(
      ctx.db,
      { name: "Book B", rawJson: raw, sourceLabel: "b.epub" },
      ctx.actor,
    );
    await expect(
      getCookbookRecipePhotoSource(ctx.db, other.entityId, imported.id, 0),
    ).rejects.toMatchObject({ cause: { reason: "CONSTRAINT_VIOLATION" } });
    await expect(
      getCookbookRecipePhotoSource(ctx.db, cookbookId, imported.id, 1),
    ).rejects.toMatchObject({ cause: { reason: "CONSTRAINT_VIOLATION" } });
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

  describe("physical copy link", () => {
    const linkedBook = async () => {
      const raw = [cookbookRecipe("Pancakes", ["2 cups flour"])];
      const cb = await upsertCookbook(
        ctx.db,
        { name: "Six Seasons", rawJson: raw, sourceLabel: "six.epub" },
        ctx.actor,
      );
      const shelfCopy = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Six Seasons: A New Way with Vegetables" }),
        ctx.actor,
      );
      return { cb, shelfCopy };
    };

    it("links a product, then clears it", async () => {
      const { cb, shelfCopy } = await linkedBook();

      const linked = await setCookbookProduct(
        ctx.db,
        ctx.actor,
        cb.entityId,
        shelfCopy.entityId,
      );
      expect(linked.product).toEqual({
        id: shelfCopy.id,
        name: "Six Seasons: A New Way with Vegetables",
        coverUrl: null,
      });

      const cleared = await setCookbookProduct(
        ctx.db,
        ctx.actor,
        cb.entityId,
        null,
      );
      expect(cleared.product).toBeNull();
    });

    // The link is a RETAINING edge, so the copy can't be deleted out from under
    // the cookbook. Blocking, not cascading: the policy vocabulary has no
    // set-null effect, and a soft-delete on this edge would take the cookbook
    // and every recipe it imported with it.
    it("blocks deleting a product a cookbook claims, until it is unlinked", async () => {
      const { cb, shelfCopy } = await linkedBook();
      await setCookbookProduct(
        ctx.db,
        ctx.actor,
        cb.entityId,
        shelfCopy.entityId,
      );

      await expect(
        deleteProducts(ctx.db, [shelfCopy.entityId], ctx.actor),
      ).rejects.toMatchObject({ cause: { reason: "PRODUCT_HAS_COOKBOOKS" } });

      await setCookbookProduct(ctx.db, ctx.actor, cb.entityId, null);
      await expect(
        deleteProducts(ctx.db, [shelfCopy.entityId], ctx.actor),
      ).resolves.toBeDefined();

      const survivors = await listCookbooks(ctx.db);
      expect(survivors.map((c) => c.id)).toContain(cb.output.id);
    });
  });
});
