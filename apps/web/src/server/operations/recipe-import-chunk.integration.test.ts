import {
  COOKBOOK_COMMAND_CHUNK,
  cookbookImportChunkInput,
} from "@cubby/schemas/import-recipe";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { upsertCookbook } from "~/server/repo/cookbook";
import { getDb } from "~/server/repo/database-helpers";
import { upsertCookbookRecipeFromCookbook } from "~/server/repo/import-recipe-convert";
import {
  makeCookbookExtraction,
  makeCookbookImportContext,
  makeCookbookRecipe,
} from "~/server/repo/repo.fixtures";
import { requireActor } from "~/server/request-context";
import { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  importCookbookChunkWorkflow,
  reprocessCookbookChunkWorkflow,
} from "./recipe-import.server";

/**
 * A client with no stream (native) imports and reprocesses a book chunk by chunk. A request that
 * ran a whole large book could time out after some recipes landed and before they were finalized,
 * so each call is bounded by the server, finalizes what landed, and also finalizes recipes an
 * earlier interrupted call left without fresh totals.
 */
describe("cookbook chunk commands", () => {
  const ctx = withTestDb();

  const workflowContext = () => {
    const context = requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const dispatched: string[][] = [];
    const real = RecipeCostingService.prototype.dispatchRecompute;
    vi.spyOn(
      RecipeCostingService.prototype,
      "dispatchRecompute",
    ).mockImplementation(async function (
      this: RecipeCostingService,
      ids,
      metadata,
    ) {
      dispatched.push([...ids]);
      return real.call(this, ids, metadata);
    });
    return { context, dispatched };
  };

  afterEach(() => vi.restoreAllMocks());

  const seedBook = async () => {
    const recipes = ["A", "B", "C"].map((name) =>
      makeCookbookRecipe(`Chunk ${name}`, ["1 cup flour"]),
    );
    const raw = makeCookbookExtraction(recipes);
    const book = await upsertCookbook(
      ctx.db,
      { name: "Chunk Book", rawJson: raw, sourceLabel: "chunk.epub" },
      ctx.actor,
    );
    return { recipes, raw, book };
  };

  it("refuses more ids than the server's cap in one call", () => {
    const ids = Array.from(
      { length: COOKBOOK_COMMAND_CHUNK + 1 },
      (_, i) => `001.${i}`,
    );
    expect(
      cookbookImportChunkInput.safeParse({
        cookbookId: "CKB-4K7M",
        recipeIds: ids,
      }).success,
    ).toBe(false);
    expect(
      cookbookImportChunkInput.safeParse({
        cookbookId: "CKB-4K7M",
        recipeIds: ids.slice(0, COOKBOOK_COMMAND_CHUNK),
      }).success,
    ).toBe(true);
  });

  it("finalizes the recipes that landed when another in the chunk fails, and says what remains", async () => {
    const { recipes, book } = await seedBook();
    const { context, dispatched } = workflowContext();
    const result = await importCookbookChunkWorkflow(context, {
      cookbookId: book.output.id,
      recipeIds: [recipes[0]!.id, "999.9999", recipes[1]!.id],
    });

    expect(result).toMatchObject({ imported: 2, failed: 1, remaining: 1 });
    expect(result.failures).toEqual([
      {
        sourceRecipeId: "999.9999",
        error: expect.stringMatching(/not in this cookbook/),
      },
    ]);
    const landed = await getDb(ctx.db).query.recipe.findMany({
      columns: { id: true, name: true },
    });
    expect(landed.map((row) => row.name).sort()).toEqual([
      "Chunk A",
      "Chunk B",
    ]);
    // Both landed recipes were sent to costing even though one sibling failed.
    const sent = new Set(dispatched.flat());
    for (const row of landed) expect(sent.has(row.id)).toBe(true);
  });

  it("also finalizes a recipe an interrupted call left without fresh totals", async () => {
    const { recipes, raw, book } = await seedBook();
    const stranded = await upsertCookbookRecipeFromCookbook(
      recipes[0]!,
      "Recipes",
      { id: book.entityId, name: "Chunk Book" },
      ctx.db,
      ctx.actor,
      makeCookbookImportContext(raw),
    );
    // The earlier request died before finalizing: totals were never computed.
    await getDb(ctx.db).execute(
      sql`update "Recipe" set "totalsComputedAt" = null where "id" = ${stranded.id}`,
    );
    const { context, dispatched } = workflowContext();
    await importCookbookChunkWorkflow(context, {
      cookbookId: book.output.id,
      recipeIds: [recipes[2]!.id],
    });
    expect(new Set(dispatched.flat()).has(stranded.id)).toBe(true);
  });

  it("reprocesses a window at a time, finalizing each, until the last window", async () => {
    const { recipes, raw, book } = await seedBook();
    for (const recipe of recipes)
      await upsertCookbookRecipeFromCookbook(
        recipe,
        "Recipes",
        { id: book.entityId, name: "Chunk Book" },
        ctx.db,
        ctx.actor,
        makeCookbookImportContext(raw),
      );
    const { context, dispatched } = workflowContext();

    const first = await reprocessCookbookChunkWorkflow(
      context,
      { cookbookId: book.output.id, offset: 0 },
      2,
    );
    expect(first).toEqual({ reprocessed: 2, nextOffset: 2 });
    const second = await reprocessCookbookChunkWorkflow(
      context,
      { cookbookId: book.output.id, offset: 2 },
      2,
    );
    expect(second).toEqual({ reprocessed: 1, nextOffset: null });
    expect(dispatched.flat().length).toBeGreaterThanOrEqual(3);
  });
});
