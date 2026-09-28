import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityAttachment, image } from "~/server/db/schema";
import { upsertCookbook } from "~/server/repo/cookbook";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { upsertCookbookRecipeFromCookbook } from "~/server/repo/import-recipe-convert";
import {
  makeCookbookExtraction,
  makeCookbookImportContext,
  makeCookbookRecipe,
} from "~/server/repo/repo.fixtures";
import {
  createImageStorageService,
  productionImageStoragePorts,
} from "~/server/services/image-storage.service";

import { attachCookbookRecipePhotoWorkflow } from "./recipe-import.server";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("cookbook recipe photo workflow", () => {
  const ctx = withTestDb();

  const setup = async () => {
    const sourceRecipes = ["Pancakes", "Waffles", "Biscuits"].map((title, i) =>
      makeCookbookRecipe(title, ["2 cups flour"], {
        id: `001.${String(10 + i).padStart(4, "0")}`,
        photos: [{ path: "OEBPS/images/shared.png", mime: "image/png" }],
      }),
    );
    const tree = makeCookbookExtraction(sourceRecipes);
    const cookbook = await upsertCookbook(
      ctx.db,
      {
        name: "Book A",
        rawJson: tree,
        sourceLabel: "book-a.epub",
      },
      ctx.actor,
    );
    const importCtx = makeCookbookImportContext(tree);
    const imported = [];
    for (const sourceRecipe of sourceRecipes) {
      imported.push(
        await upsertCookbookRecipeFromCookbook(
          sourceRecipe,
          "Recipes",
          { id: cookbook.entityId, name: "Book A" },
          ctx.db,
          ctx.actor,
          importCtx,
        ),
      );
    }
    return {
      cookbookId: cookbook.output.id,
      recipes: imported.map((row, i) => ({
        entityId: row.id,
        recipeId: parseShortcodeFor("recipe", row.shortcode),
        sourceRecipeId: sourceRecipes[i]!.id,
      })),
    };
  };

  it("attaches shared bytes independently, deduplicates retries, and preserves an existing photo", async () => {
    const ids = await setup();
    const uploaded: string[] = [];
    const deleted: string[] = [];
    let failDeletes = false;
    let sequence = 0;
    const storage = createImageStorageService({
      ...productionImageStoragePorts,
      objectStorage: {
        ...productionImageStoragePorts.objectStorage,
        generateImageKey: (filename) =>
          `tests/cookbook-photo/${sequence++}-${filename}`,
        upload: async ({ key }) => {
          uploaded.push(key);
        },
        deleteObject: async (key) => {
          if (failDeletes) throw new Error("object store unavailable");
          deleted.push(key);
        },
        getPublicUrl: (key) => `https://images.example/${key}`,
      },
    });
    const ports = { attachFile: storage.attachFileToEntity };
    const [first, second, existing] = ids.recipes;
    if (!first || !second || !existing) throw new Error("Missing test recipes");

    await expect(
      attachCookbookRecipePhotoWorkflow(
        { db: ctx.db },
        {
          cookbookId: ids.cookbookId,
          recipeId: first.recipeId,
          sourceRecipeId: first.sourceRecipeId,
          data: PNG_BASE64,
        },
        ports,
      ),
    ).resolves.toEqual({ status: "attached" });
    await expect(
      attachCookbookRecipePhotoWorkflow(
        { db: ctx.db },
        {
          cookbookId: ids.cookbookId,
          recipeId: second.recipeId,
          sourceRecipeId: second.sourceRecipeId,
          data: PNG_BASE64,
        },
        ports,
      ),
    ).resolves.toEqual({ status: "attached" });
    await expect(
      attachCookbookRecipePhotoWorkflow(
        { db: ctx.db },
        {
          cookbookId: ids.cookbookId,
          recipeId: first.recipeId,
          sourceRecipeId: first.sourceRecipeId,
          data: PNG_BASE64,
        },
        ports,
      ),
    ).resolves.toEqual({ status: "skipped-existing" });
    expect(uploaded).toHaveLength(2);

    await storage.attachFileToEntity(ctx.db, {
      entityType: "recipe",
      entityId: existing.recipeId,
      data: PNG_BASE64,
      contentType: "image/png",
      filename: "existing.png",
      idempotencyKey: "existing-photo",
    });
    await expect(
      attachCookbookRecipePhotoWorkflow(
        { db: ctx.db },
        {
          cookbookId: ids.cookbookId,
          recipeId: existing.recipeId,
          sourceRecipeId: existing.sourceRecipeId,
          data: PNG_BASE64,
        },
        ports,
      ),
    ).resolves.toEqual({ status: "skipped-existing" });
    expect(deleted).toHaveLength(0);

    failDeletes = true;
    await expect(
      storage.attachFileToEntity(ctx.db, {
        entityType: "recipe",
        entityId: existing.recipeId,
        data: PNG_BASE64,
        contentType: "image/png",
        filename: "race.png",
        idempotencyKey: "failed-race",
        expectedImageCount: 0,
      }),
    ).rejects.toThrow(/uploaded object could not be cleaned up/);

    const joins = await getDb(ctx.db)
      .select({ recipeId: entityAttachment.subjectEntityId })
      .from(entityAttachment)
      .where(notDeleted(entityAttachment));
    expect(joins.map((row) => row.recipeId).sort()).toEqual(
      [first.entityId, second.entityId, existing.entityId].sort(),
    );
    const pending = await getDb(ctx.db).query.image.findMany({
      where: and(eq(image.status, "PENDING"), notDeleted(image)),
    });
    expect(pending).toHaveLength(1);
  });
});
