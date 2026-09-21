import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import {
  importRecipeImageFromUrl,
  type RecipeImageImportPort,
} from "./image-import";

const RECIPE_ID = testEntityId(
  "recipe",
  "11111111-1111-1111-1111-111111111111",
);
const SOURCE_URL = "https://recipes.example/photo.jpg";
const db = new Database(() => {
  throw new Error(
    "The injected recipe image port must not access the database",
  );
});

const hasImages = vi.fn<RecipeImageImportPort["hasImages"]>();
const importFromUrl = vi.fn<RecipeImageImportPort["importFromUrl"]>();
const associate = vi.fn<RecipeImageImportPort["associate"]>();
const port: RecipeImageImportPort = { hasImages, importFromUrl, associate };

describe("importRecipeImageFromUrl", () => {
  beforeEach(() => {
    hasImages.mockReset().mockResolvedValue(false);
    associate.mockReset().mockResolvedValue(undefined);
    importFromUrl.mockReset().mockResolvedValue({
      imageId: testShortcode("image", "IMG-0001"),
      key: "imports/recipe.jpg",
      url: "https://images.example/imports/recipe.jpg",
      created: true,
    });
  });

  it("imports the photo and attaches it to the recipe", async () => {
    const result = await importRecipeImageFromUrl(
      db,
      RECIPE_ID,
      SOURCE_URL,
      port,
    );

    expect(result).toEqual({ imageId: testShortcode("image", "IMG-0001") });
    expect(importFromUrl).toHaveBeenCalledWith(db, {
      sourceUrl: SOURCE_URL,
      filenamePrefix: `recipe-${RECIPE_ID}`,
    });
    expect(associate).toHaveBeenCalledWith(db, RECIPE_ID, [
      testShortcode("image", "IMG-0001"),
    ]);
  });

  it("no-ops when the recipe already has an image (re-import)", async () => {
    hasImages.mockResolvedValue(true);

    const result = await importRecipeImageFromUrl(
      db,
      RECIPE_ID,
      SOURCE_URL,
      port,
    );

    expect(result).toBeNull();
    expect(importFromUrl).not.toHaveBeenCalled();
    expect(associate).not.toHaveBeenCalled();
  });

  it("swallows a failed import so it can't sink the recipe import", async () => {
    importFromUrl.mockRejectedValue(new Error("403 Forbidden"));

    await expect(
      importRecipeImageFromUrl(db, RECIPE_ID, SOURCE_URL, port),
    ).resolves.toBeNull();
    expect(associate).not.toHaveBeenCalled();
  });
});
