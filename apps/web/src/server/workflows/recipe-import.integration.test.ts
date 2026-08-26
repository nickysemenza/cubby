import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as S3 from "~/server/utils/s3";

const fetchAndStoreImage = vi.hoisted(() => vi.fn());
vi.mock("~/server/utils/s3", async (importActual) => ({
  ...(await importActual<typeof S3>()),
  fetchAndStoreImage,
}));

import { setCfEnv } from "~/server/cf-env";
import { getRecipeByShortcode } from "~/server/repo/recipe";
import { makeImportRecipe } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";
import { insertImportWorkflow } from "./recipe-import.server";

describe("insertImportWorkflow image persistence", () => {
  const ctx = withTestDb();
  const workflowContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
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
    setCfEnv({
      BACKGROUND_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    } as unknown as Env);
  });
  afterEach(() => setCfEnv(undefined as unknown as Env));

  const attachedImages = async (recipeId: RecipeShortcode) =>
    (await getRecipeByShortcode(ctx.db, recipeId))?.images ?? [];

  it("fetches and attaches the image only once across re-imports", async () => {
    const { id } = await insertImportWorkflow(workflowContext(), imported);
    const entityId = await resolveLiveShortcode(ctx.db, id, "recipe");

    expect(fetchAndStoreImage).toHaveBeenCalledWith(
      "https://recipes.example/hero.jpg",
      `recipe-${entityId}`,
    );
    expect(await attachedImages(id)).toMatchObject([
      { url: getR2PublicUrl("imports/hero.jpg"), status: "UPLOADED" },
    ]);

    const second = await insertImportWorkflow(workflowContext(), imported);
    expect(second.id).toBe(id);
    expect(fetchAndStoreImage).toHaveBeenCalledTimes(1);
    expect(await attachedImages(id)).toHaveLength(1);
  });

  it("still imports the recipe when the image cannot be fetched", async () => {
    fetchAndStoreImage.mockResolvedValue(null);
    const { id } = await insertImportWorkflow(
      workflowContext(),
      makeImportRecipe({
        ...imported,
        meta: { title: "Unphotographed Recipe" },
      }),
    );

    expect(id).toMatch(/^RCP-/);
    expect(await attachedImages(id)).toEqual([]);
  });
});
