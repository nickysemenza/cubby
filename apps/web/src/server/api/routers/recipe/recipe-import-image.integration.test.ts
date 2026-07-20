import type { RecipeId } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the network/R2 hop is faked — the DB writes (Image row + recipeImage
// join + status flip) are the thing under test.
const fetchAndStoreImage = vi.hoisted(() => vi.fn());
vi.mock("~/server/utils/s3", async (importActual) => ({
  ...(await importActual<typeof import("~/server/utils/s3")>()),
  fetchAndStoreImage,
}));

import { setCfEnv } from "~/server/cf-env";
import { makeImportRecipe } from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../../trpc";
import { recipeRouter } from "../recipe";

// The scrape/MCP import path (`recipe.insertImport`) must persist the scraped
// hero photo — the browser form does it client-side via `image.importFromUrl`,
// and for a long time the server path silently dropped `ImportRecipe.image`.
describe("recipe.insertImport persists the scraped image", () => {
  const ctx = withTestDb();

  const imported = makeImportRecipe({
    meta: { title: "Photographed Recipe" },
    url: "https://example.com/recipe",
    image: "https://recipes.example/hero.jpg",
    sections: [
      {
        instructions: ["Mix", "Bake"],
        ingredients: ["2 cups flour"],
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchAndStoreImage.mockResolvedValue({
      key: "imports/hero.jpg",
      url: "https://images.example/imports/hero.jpg",
      size: 1234,
      contentType: "image/jpeg",
    });
    // Queue the recompute instead of draining it inline — this test is about
    // the image, not costing.
    setCfEnv({
      BACKGROUND_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    } as unknown as Env);
  });

  // Read back through the router, the way the recipe page does.
  const attachedImages = async (recipeId: RecipeId) =>
    (await createTestCaller(recipeRouter, ctx.db).getByID({ id: recipeId }))
      .images;

  it("fetches the image into R2 and attaches it, once across re-imports", async () => {
    const caller = createTestCaller(recipeRouter, ctx.db);

    const { id } = await caller.insertImport(imported);

    expect(fetchAndStoreImage).toHaveBeenCalledWith(
      "https://recipes.example/hero.jpg",
      `recipe-${id}`,
    );
    expect(await attachedImages(id)).toMatchObject([
      { url: "https://images.example/imports/hero.jpg", status: "UPLOADED" },
    ]);

    // Re-importing the same recipe must not stack a second R2 object.
    const second = await caller.insertImport(imported);
    expect(second.id).toBe(id);
    expect(fetchAndStoreImage).toHaveBeenCalledTimes(1);
    expect(await attachedImages(id)).toHaveLength(1);
  });

  it("still imports the recipe when the photo can't be fetched", async () => {
    fetchAndStoreImage.mockResolvedValue(null);
    const caller = createTestCaller(recipeRouter, ctx.db);

    const { id } = await caller.insertImport(
      makeImportRecipe({
        ...imported,
        meta: { title: "Unphotographed Recipe" },
      }),
    );

    expect(id).toBeDefined();
    expect(await attachedImages(id)).toEqual([]);
  });
});
