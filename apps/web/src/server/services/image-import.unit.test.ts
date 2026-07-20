import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  associateImagesWithRecipe: vi.fn(),
  recipeHasImages: vi.fn(),
  importImageFromUrl: vi.fn(),
}));

vi.mock("~/server/repo/image", () => ({
  associateImagesWithProduct: vi.fn(),
  associateImagesWithRecipe: mocks.associateImagesWithRecipe,
  recipeHasImages: mocks.recipeHasImages,
}));

vi.mock("~/server/services/image-storage.service", () => ({
  importImageFromUrl: mocks.importImageFromUrl,
}));

import { importRecipeImageFromUrl } from "./image-import";

const RECIPE_ID = unsafeRecipeId("11111111-1111-1111-1111-111111111111");
const SOURCE_URL = "https://recipes.example/photo.jpg";
const db = {} as never;

describe("importRecipeImageFromUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recipeHasImages.mockResolvedValue(false);
    mocks.importImageFromUrl.mockResolvedValue({
      imageId: "image-1",
      key: "imports/recipe.jpg",
      url: "https://images.example/imports/recipe.jpg",
    });
  });

  it("imports the photo and attaches it to the recipe", async () => {
    const result = await importRecipeImageFromUrl(db, RECIPE_ID, SOURCE_URL);

    expect(result).toEqual({ imageId: "image-1" });
    expect(mocks.importImageFromUrl).toHaveBeenCalledWith(db, {
      sourceUrl: SOURCE_URL,
      filenamePrefix: `recipe-${RECIPE_ID}`,
    });
    expect(mocks.associateImagesWithRecipe).toHaveBeenCalledWith(
      db,
      RECIPE_ID,
      ["image-1"],
    );
  });

  it("no-ops when the recipe already has an image (re-import)", async () => {
    mocks.recipeHasImages.mockResolvedValue(true);

    const result = await importRecipeImageFromUrl(db, RECIPE_ID, SOURCE_URL);

    expect(result).toBeNull();
    expect(mocks.importImageFromUrl).not.toHaveBeenCalled();
    expect(mocks.associateImagesWithRecipe).not.toHaveBeenCalled();
  });

  it("swallows a failed import so it can't sink the recipe import", async () => {
    mocks.importImageFromUrl.mockRejectedValue(new Error("403 Forbidden"));

    await expect(
      importRecipeImageFromUrl(db, RECIPE_ID, SOURCE_URL),
    ).resolves.toBeNull();
    expect(mocks.associateImagesWithRecipe).not.toHaveBeenCalled();
  });
});
