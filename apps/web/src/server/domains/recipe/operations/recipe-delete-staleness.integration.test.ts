import type { RecipeId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { BackgroundTaskMessage } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { upsertCookbook } from "~/server/domains/cookbook/repo/cookbook";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { createProduct } from "~/server/domains/product/repo/crud";
import {
  createRecipe,
  getRecipeByID,
  upsertCookbookRecipe,
} from "~/server/domains/recipe/repo/crud";
import { getRecipeTotalsState } from "~/server/domains/recipe/repo/totals";
import { executeEntity } from "~/server/entity-kernel";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { requireActor } from "~/server/http/request-context";
import {
  drainDerivedRefreshFrontier,
  drainRecipeRefreshJobs,
} from "~/server/testing/background-queue";
import { makeCookbookExtraction } from "~/server/testing/repo.fixtures";
import {
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { deleteCookbookWorkflow } from "./recipe-import.server";

describe("recipe deletion cost-staleness workflows", () => {
  const ctx = withTestDb();
  const workflowContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
  const recompute = async (ids: RecipeId[]) => {
    const costing = workflowContext().services.recipeCosting;
    await costing.recompute(ids);
    await drainRecipeRefreshJobs(ctx.db, costing);
  };
  /** A queue that records the kind of every task published to it. */
  const installFakeQueue = () => {
    const published: string[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          send: async () => {},
          sendBatch: async (
            messages: Iterable<{ body: BackgroundTaskMessage }>,
          ) => {
            for (const message of messages)
              published.push(message.body.queueType);
          },
        },
      }),
    );
    return published;
  };

  afterEach(() => setCfEnv(undefined));

  const seedParentWithSubRecipe = async (
    options: { parentIsFork?: boolean } = {},
  ) => {
    const ingredient = await findOrCreateIngredient(ctx.db, "sub flour");
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "sub product",
        ingredientId: ingredient.id,
        price: 4,
      }),
      ctx.actor,
    );
    const child = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Sub Recipe B",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredient.shortcode, {
                amounts: [{ value: 2, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const parentInput = makeRecipeInput({
      name: "Parent Recipe A",
      sections: [
        {
          instructions: [{ instruction: "Use B" }],
          ingredients: [
            {
              type: "recipe",
              recipeId: child.id,
              ingredientId: null,
              amounts: [{ value: 1, unit: "each" }],
            },
          ],
        },
      ],
    });
    if (options.parentIsFork) parentInput.forkedFromRecipeId = child.id;
    const parent = await createRecipe(ctx.db, parentInput, ctx.actor);
    const [childEntityId, parentEntityId] = await Promise.all([
      resolveLiveShortcode(ctx.db, child.id, "recipe"),
      resolveLiveShortcode(ctx.db, parent.id, "recipe"),
    ]);
    if (!childEntityId || !parentEntityId) throw new Error("seed failed");
    return {
      child: parseEntityId("recipe", childEntityId),
      childCode: child.id,
      parent: parseEntityId("recipe", parentEntityId),
    };
  };

  it("refreshes the parent after its sub-recipe is deleted", async () => {
    const { child, childCode, parent } = await seedParentWithSubRecipe();
    await drainDerivedRefreshFrontier(ctx.db);
    await recompute([parent, child]);
    const computedBefore = (await getRecipeTotalsState(ctx.db, parent))
      ?.totalsComputedAt;
    expect(
      (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
    ).not.toBeNull();

    const published = installFakeQueue();
    await executeEntity(workflowContext(), {
      action: "delete",
      entity: "recipe",
      ids: [childCode],
    });
    await drainDerivedRefreshFrontier(ctx.db);
    await drainRecipeRefreshJobs(
      ctx.db,
      workflowContext().services.recipeCosting,
    );

    expect(
      (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
    ).toBeInstanceOf(Date);
    expect(
      (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
    ).not.toEqual(computedBefore);
    expect(published).toContain("background");
  });

  it(
    "refreshes a parent that was a fork of the deleted sub-recipe",
    { timeout: 10_000 },
    async () => {
      // Clearing the fork pointer and recording refresh intent share the
      // delete transaction; a second connection must not lock that same row.
      const { child, childCode, parent } = await seedParentWithSubRecipe({
        parentIsFork: true,
      });
      await drainDerivedRefreshFrontier(ctx.db);
      await recompute([parent, child]);
      const computedBefore = (await getRecipeTotalsState(ctx.db, parent))
        ?.totalsComputedAt;

      const published = installFakeQueue();
      await executeEntity(workflowContext(), {
        action: "delete",
        entity: "recipe",
        ids: [childCode],
      });
      await drainDerivedRefreshFrontier(ctx.db);
      await drainRecipeRefreshJobs(
        ctx.db,
        workflowContext().services.recipeCosting,
      );

      expect(
        (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
      ).toBeInstanceOf(Date);
      expect(
        (await getRecipeTotalsState(ctx.db, parent))?.totalsComputedAt,
      ).not.toEqual(computedBefore);
      expect(
        (await getRecipeByID(ctx.db, parent))?.forkedFromRecipeId,
      ).toBeNull();
      expect(published).toContain("background");
    },
  );

  it("refreshes external parents after a cookbook deletes their sub-recipe", async () => {
    const bookName = "Doomed Book";
    const { output: cookbook, entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      {
        name: bookName,
        rawJson: makeCookbookExtraction(),
        sourceLabel: bookName,
      },
      ctx.actor,
    );
    const ingredient = await findOrCreateIngredient(ctx.db, "book flour");
    const child = await upsertCookbookRecipe(
      makeRecipeInput({
        name: "Book Sub Recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredient.shortcode, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      { id: cookbookId, name: bookName },
      ctx.db,
      ctx.actor,
    );
    const parent = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Non-Book Parent",
        sections: [
          {
            instructions: [{ instruction: "Use book sub" }],
            ingredients: [
              {
                type: "recipe",
                recipeId: parseShortcodeFor("recipe", child.shortcode),
                ingredientId: null,
                amounts: [{ value: 1, unit: "each" }],
              },
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const parentEntityId = await resolveLiveShortcode(
      ctx.db,
      parent.id,
      "recipe",
    );
    if (!parentEntityId) throw new Error("seed failed");
    const resolvedParentId = parseEntityId("recipe", parentEntityId);
    await recompute([resolvedParentId, child.id]);
    const computedBefore = (
      await getRecipeTotalsState(ctx.db, resolvedParentId)
    )?.totalsComputedAt;
    expect(
      (await getRecipeTotalsState(ctx.db, resolvedParentId))?.totalsComputedAt,
    ).not.toBeNull();

    installFakeQueue();
    await deleteCookbookWorkflow(workflowContext(), {
      cookbookId: cookbook.id,
    });
    await drainRecipeRefreshJobs(
      ctx.db,
      workflowContext().services.recipeCosting,
    );

    expect(
      (await getRecipeTotalsState(ctx.db, resolvedParentId))?.totalsComputedAt,
    ).toBeInstanceOf(Date);
    expect(
      (await getRecipeTotalsState(ctx.db, resolvedParentId))?.totalsComputedAt,
    ).not.toEqual(computedBefore);
  });
});
