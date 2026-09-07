import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { image, recipeImage } from "~/server/db/schema";
import { upsertCookbook } from "~/server/repo/cookbook";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { upsertCookbookRecipeFromCookbook } from "~/server/repo/import-recipe-convert";
import { cookbookRecipe } from "~/server/repo/repo.fixtures";
import {
  createImageStorageService,
  productionImageStoragePorts,
} from "~/server/services/image-storage.service";

import { attachCookbookRecipePhotoWorkflow } from "./recipe-import.server";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("cookbook recipe photo workflow", () => {
  const ctx = withTestDb("epub_import");

  const setup = async () => {
    const sourceRecipes = ["Pancakes", "Waffles", "Biscuits"].map((title) =>
      cookbookRecipe(title, ["2 cups flour"], {
        image: {
          kind: "epub",
          path: "OEBPS/images/shared.png",
          mime: "image/png",
        },
      }),
    );
    const cookbook = await upsertCookbook(
      ctx.db,
      {
        name: "Book A",
        rawJson: sourceRecipes,
        sourceLabel: "book-a.epub",
      },
      ctx.actor,
    );
    const imported = await Promise.all(
      sourceRecipes.map((sourceRecipe) =>
        upsertCookbookRecipeFromCookbook(
          sourceRecipe,
          { id: cookbook.entityId, name: "Book A" },
          ctx.db,
          ctx.actor,
        ),
      ),
    );
    return {
      cookbookId: cookbook.output.id,
      recipes: imported.map((row) => ({
        entityId: row.id,
        recipeId: parseShortcodeFor("recipe", row.shortcode),
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
          sourceIndex: 0,
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
          sourceIndex: 1,
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
          sourceIndex: 0,
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
          sourceIndex: 2,
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
      .select({ recipeId: recipeImage.recipeId })
      .from(recipeImage)
      .where(notDeleted(recipeImage));
    expect(joins.map((row) => row.recipeId).sort()).toEqual(
      [first.entityId, second.entityId, existing.entityId].sort(),
    );
    const pending = await getDb(ctx.db).query.image.findMany({
      where: and(eq(image.status, "PENDING"), notDeleted(image)),
    });
    expect(pending).toHaveLength(1);
  });
});
