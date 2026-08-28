import {
  parseShortcodeFor,
  type RecipeShortcode,
} from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { createUploadedImageRecord } from "~/server/repo/image";
import { getRecipeByShortcode } from "~/server/repo/recipe";
import { makeImportRecipe } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import {
  insertImportWorkflow,
  type RecipeImportWorkflowPorts,
} from "./recipe-import.server";

describe("insertImportWorkflow image persistence", () => {
  const ctx = withTestDb();
  const importImageFromUrl: RecipeImportWorkflowPorts["importImageFromUrl"] =
    vi.fn(async (db, params) => {
      const created = await createUploadedImageRecord(db, {
        key: "imports/hero.jpg",
        filename: params.filenamePrefix,
        size: 1234,
        contentType: "image/jpeg",
      });
      return {
        imageId: parseShortcodeFor("image", created.shortcode),
        key: "imports/hero.jpg",
        url: getR2PublicUrl("imports/hero.jpg"),
      };
    });
  const ports: RecipeImportWorkflowPorts = { importImageFromUrl };
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
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: { send: async () => {}, sendBatch: async () => {} },
      }),
    );
  });
  afterEach(() => setCfEnv(undefined));

  const attachedImages = async (recipeId: RecipeShortcode) =>
    (await getRecipeByShortcode(ctx.db, recipeId))?.images ?? [];

  it("fetches and attaches the image only once across re-imports", async () => {
    const { id } = await insertImportWorkflow(
      workflowContext(),
      imported,
      ports,
    );
    const entityId = await resolveLiveShortcode(ctx.db, id, "recipe");

    expect(importImageFromUrl).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({
        sourceUrl: "https://recipes.example/hero.jpg",
        filenamePrefix: `recipe-${entityId}`,
      }),
    );
    expect(await attachedImages(id)).toMatchObject([
      { url: getR2PublicUrl("imports/hero.jpg"), status: "UPLOADED" },
    ]);

    const second = await insertImportWorkflow(
      workflowContext(),
      imported,
      ports,
    );
    expect(second.id).toBe(id);
    expect(importImageFromUrl).toHaveBeenCalledTimes(1);
    expect(await attachedImages(id)).toHaveLength(1);
  });

  it("still imports the recipe when the image cannot be fetched", async () => {
    vi.mocked(importImageFromUrl).mockResolvedValueOnce(null);
    const { id } = await insertImportWorkflow(
      workflowContext(),
      makeImportRecipe({
        ...imported,
        meta: { title: "Unphotographed Recipe" },
      }),
      ports,
    );

    expect(id).toMatch(/^RCP-/);
    expect(await attachedImages(id)).toEqual([]);
  });
});
