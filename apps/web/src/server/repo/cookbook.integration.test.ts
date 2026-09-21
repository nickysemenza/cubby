import {
  cookbookDiffInput,
  upsertCookbookInput,
} from "@cubby/schemas/import-recipe";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  cookbook,
  entityEmbedding,
  recipe,
  recipeSection,
} from "~/server/db/schema";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import {
  deleteCookbookWorkflow,
  getCookbookDiffWorkflow,
  importCookbookWorkflow,
  reprocessCookbookWorkflow,
  upsertCookbookWorkflow,
} from "~/server/workflows/recipe-import.server";

import {
  getCookbookByName,
  getCookbookRecipePhotoSource,
  getCookbookSource,
  listCookbooks,
  setCookbookProduct,
  upsertCookbook,
} from "./cookbook";
import { getDb } from "./database-helpers";
import { createPendingImageRecord } from "./image";
import { upsertCookbookRecipeFromCookbook } from "./import-recipe-convert";
import { deleteProducts } from "./product";
import {
  createProductFixture,
  makeCookbookExtraction,
  makeCookbookImportContext,
  makeCookbookRecipe,
  makeProductInput,
} from "./repo.fixtures";

// EPUB importer suite — actor audits as an epub import, not the UI.
describe("cookbook repository", () => {
  const ctx = withTestDb("epub_import");
  const workflowContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  it("upsertCookbook creates then updates by name (no duplicate)", async () => {
    const raw = makeCookbookExtraction([
      makeCookbookRecipe("Pancakes", ["2 cups flour"]),
    ]);
    const first = await upsertCookbook(
      ctx.db,
      { name: "Book A", rawJson: raw, author: ["Ada"], sourceLabel: "a.epub" },
      ctx.actor,
    );
    const second = await upsertCookbookWorkflow(
      workflowContext(),
      upsertCookbookInput.parse({
        name: "Book A",
        rawJson: raw,
        author: ["Ada", "Bob"],
        subjects: ["Baking"],
        sourceLabel: "a.epub",
      }),
    );

    expect(second.id).toBe(first.output.id);
    const cb = await getCookbookByName(ctx.db, "Book A");
    expect(cb?.id).toBe(first.entityId);
    expect(cb?.author).toEqual(["Ada", "Bob"]);
    expect(cb?.subjects).toEqual(["Baking"]);
    expect(cb?.rawJson.chapters[0]?.items).toHaveLength(1);
    expect(cb?.sourceRecipeCount).toBe(1);
  });

  it("returns no diff for a missing book and recipes for an existing book", async () => {
    await expect(
      getCookbookDiffWorkflow(
        workflowContext(),
        cookbookDiffInput.parse({ book: "Missing diff book" }),
      ),
    ).resolves.toEqual([]);

    const book = await upsertCookbook(
      ctx.db,
      {
        name: "Diff Book",
        rawJson: makeCookbookExtraction([
          makeCookbookRecipe("Diff Pancakes", ["1 cup flour"], {
            id: "001.0001",
          }),
        ]),
        sourceLabel: "diff.epub",
      },
      ctx.actor,
    );
    for await (const _event of importCookbookWorkflow(workflowContext(), {
      cookbookId: book.output.id,
      recipeIds: ["001.0001"],
    })) {
      // Drain the stream so the recipe commit and finalization complete.
    }

    await expect(
      getCookbookDiffWorkflow(
        workflowContext(),
        cookbookDiffInput.parse({ book: "Diff Book" }),
      ),
    ).resolves.toEqual([
      expect.objectContaining({ title: "Diff Pancakes", hasImage: false }),
    ]);
  });

  it("streams cookbook row failures without discarding earlier committed recipes", async () => {
    const raw = makeCookbookExtraction([
      makeCookbookRecipe("Streamed Pancakes", ["2 cups flour"], {
        id: "001.0001",
      }),
    ]);
    const book = await upsertCookbook(
      ctx.db,
      { name: "Streamed Book", rawJson: raw, sourceLabel: "streamed.epub" },
      ctx.actor,
    );
    const events = [];
    for await (const event of importCookbookWorkflow(workflowContext(), {
      cookbookId: book.output.id,
      recipeIds: ["001.0001", "009.0007"],
    }))
      events.push(event);

    expect(events).toMatchObject([
      { type: "progress", done: 0, total: 2 },
      {
        type: "progress",
        done: 1,
        total: 2,
        item: { sourceRecipeId: "001.0001", ok: true },
      },
      {
        type: "progress",
        done: 2,
        total: 2,
        item: { sourceRecipeId: "009.0007", ok: false },
      },
      { type: "done", result: { succeeded: 1, failed: 1 } },
    ]);
    const persisted = await getDb(ctx.db).query.recipe.findMany({
      where: eq(recipe.cookbookId, book.entityId),
      columns: { name: true },
    });
    expect(persisted).toEqual([{ name: "Streamed Pancakes" }]);
  });

  it("reprocesses no recipes without inventing a progress item and returns extras", async () => {
    const raw = makeCookbookExtraction([
      makeCookbookRecipe("Deferred Recipe", ["1 pinch salt"]),
    ]);
    const book = await upsertCookbook(
      ctx.db,
      { name: "Deferred Book", rawJson: raw, sourceLabel: "deferred.epub" },
      ctx.actor,
    );
    const events = [];
    for await (const event of reprocessCookbookWorkflow(workflowContext(), {
      cookbookId: book.output.id,
    }))
      events.push(event);
    expect(events).toEqual([
      {
        type: "done",
        result: { reprocessed: 0, importableExtras: ["Deferred Recipe"] },
      },
    ]);
  });

  it("finalizes the first committed cookbook import on close without starting the next row", async () => {
    const raw = makeCookbookExtraction([
      makeCookbookRecipe("Close First", ["1 cup flour"], { id: "001.0001" }),
      makeCookbookRecipe("Close Second", ["1 cup water"], { id: "001.0020" }),
    ]);
    const book = await upsertCookbook(
      ctx.db,
      { name: "Closing Book", rawJson: raw, sourceLabel: "closing.epub" },
      ctx.actor,
    );
    const stream = importCookbookWorkflow(workflowContext(), {
      cookbookId: book.output.id,
      recipeIds: ["001.0001", "001.0020"],
    });
    await stream.next();
    await stream.next();
    await stream.return();

    const persisted = await getDb(ctx.db).query.recipe.findMany({
      where: eq(recipe.cookbookId, book.entityId),
      columns: { name: true },
    });
    expect(persisted).toEqual([{ name: "Close First" }]);
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
        rawJson: makeCookbookExtraction(),
        sourceLabel: "covered.epub",
        coverImageId: firstCover.id,
      },
      ctx.actor,
    );
    await upsertCookbook(
      ctx.db,
      {
        name: "Covered Book",
        rawJson: makeCookbookExtraction(),
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

  it("authorizes an EPUB photo by live cookbook, source recipe id, recipe membership, and name", async () => {
    const pancakes = makeCookbookRecipe("Pancakes", ["2 cups flour"], {
      id: "001.0001",
      photos: [
        {
          path: "OEBPS/images/pancakes.jpg",
          mime: "image/jpeg",
          alt: "Pancakes",
        },
      ],
    });
    const raw = makeCookbookExtraction([pancakes]);
    const { entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      { name: "Book A", rawJson: raw, sourceLabel: "a.epub" },
      ctx.actor,
    );
    const imported = await upsertCookbookRecipeFromCookbook(
      pancakes,
      "Recipes",
      { id: cookbookId, name: "Book A" },
      ctx.db,
      ctx.actor,
      makeCookbookImportContext(raw),
    );

    await expect(
      getCookbookRecipePhotoSource(ctx.db, cookbookId, imported.id, "001.0001"),
    ).resolves.toEqual({
      path: "OEBPS/images/pancakes.jpg",
      mime: "image/jpeg",
    });

    const other = await upsertCookbook(
      ctx.db,
      { name: "Book B", rawJson: raw, sourceLabel: "b.epub" },
      ctx.actor,
    );
    await expect(
      getCookbookRecipePhotoSource(
        ctx.db,
        other.entityId,
        imported.id,
        "001.0001",
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    await expect(
      getCookbookRecipePhotoSource(ctx.db, cookbookId, imported.id, "001.0999"),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
  });

  it("refuses to import from a cookbook stored in the retired flat format", async () => {
    const legacy = await upsertCookbook(
      ctx.db,
      {
        name: "Legacy Book",
        rawJson: makeCookbookExtraction(),
        sourceLabel: "old.epub",
      },
      ctx.actor,
    );
    // Rows written before the tree format hold a flat array; the column's
    // type cannot express that, so the row is rewritten in SQL.
    await getDb(ctx.db)
      .update(cookbook)
      .set({ rawJson: sql`'[]'::jsonb` })
      .where(eq(cookbook.id, legacy.entityId));
    const summaries = await listCookbooks(ctx.db);
    expect(
      summaries.find((s) => s.book === "Legacy Book")?.needsReextract,
    ).toBe(true);
    await expect(
      getCookbookSource(ctx.db, legacy.entityId),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
  });

  // deleteCookbook is UNGUARDED (lockAndValidateForDelete only locks + checks
  // existence — no assertNoDependents call for sub-recipe usage or meal-plan
  // membership), so it cascades to every imported recipe unconditionally. This
  // guards the removal-path invariant from root AGENTS.md: the cascade must
  // reach sections/ingredients AND leave no live EntityEmbedding row for
  // either the cookbook or its recipes (mirrors
  // embedding-cascade-invariant.integration.test.ts's per-entity coverage,
  // which only asserts the Cookbook row's own embedding — this exercises the
  // recipe cascade underneath it too).
  it("deleteCookbook soft-deletes the book, its recipes, sections, ingredients, and leaves no embedding orphans", async () => {
    const pancakes = makeCookbookRecipe("Pancakes", ["2 cups flour"]);
    const raw = makeCookbookExtraction([pancakes]);
    const { entityId: cookbookId, output: book } = await upsertCookbook(
      ctx.db,
      { name: "Book A", rawJson: raw, sourceLabel: "a.epub" },
      ctx.actor,
    );
    const ref = { id: cookbookId, name: "Book A" };
    const { id: recipeId } = await upsertCookbookRecipeFromCookbook(
      pancakes,
      "Recipes",
      ref,
      ctx.db,
      ctx.actor,
      makeCookbookImportContext(raw),
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

    // Seed a live search-embedding bookkeeping row for both the cookbook and
    // its recipe (the vector itself lives in Vectorize, not Postgres).
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
        });
    await seedEmbedding("cookbook", cookbookId);
    await seedEmbedding("recipe", recipeId);

    const deleted = await deleteCookbookWorkflow(workflowContext(), {
      cookbookId: book.id,
    });
    expect(deleted.deletedRecipes).toBe(1);

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
  });

  describe("physical copy link", () => {
    const linkedBook = async () => {
      const raw = makeCookbookExtraction([
        makeCookbookRecipe("Pancakes", ["2 cups flour"]),
      ]);
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
      ).rejects.toMatchObject({ reason: "PRODUCT_HAS_COOKBOOKS" });

      await setCookbookProduct(ctx.db, ctx.actor, cb.entityId, null);
      await expect(
        deleteProducts(ctx.db, [shelfCopy.entityId], ctx.actor),
      ).resolves.toBeDefined();

      const survivors = await listCookbooks(ctx.db);
      expect(survivors.map((c) => c.id)).toContain(cb.output.id);
    });
  });
});
