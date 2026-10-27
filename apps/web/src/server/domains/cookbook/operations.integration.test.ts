import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recipeHandlers } from "~/server/domains/recipe/operations/recipe.server";
import { systemPrincipal } from "~/server/http/authenticate";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeCookbookExtraction,
  makeCookbookRecipe,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { cookbookHandlers } from "./operations.server";
import { getCookbookSource, upsertCookbook } from "./repo/cookbook";

let backgroundQueue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  backgroundQueue = captureBackgroundQueue();
});
afterEach(() => backgroundQueue.restore());

describe("Cookbook public operation envelopes", () => {
  const ctx = withTestDb();
  const request = () => ({
    principal: systemPrincipal(buildKernelContext(ctx.db, ctx.actor.userId)),
    headers: new Headers(),
    signal: new AbortController().signal,
  });

  it("returns canonical counts from list, update and physical-copy linking while retaining source evidence", async () => {
    const extraction = makeCookbookExtraction([
      makeCookbookRecipe("Synthetic bread", ["2 cups flour"]),
    ]);
    const book = await upsertCookbook(
      ctx.db,
      {
        name: "Synthetic field cookbook",
        author: ["Synthetic author"],
        subjects: ["Baking"],
        rawJson: extraction,
        sourceLabel: "synthetic.epub",
      },
      ctx.actor,
    );
    const sourceBefore = await getCookbookSource(ctx.db, book.entityId);
    const listed = await cookbookHandlers.operations.list({
      data: null,
      request: request(),
    });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.ok).toBe(true);
    const row = listed.data.find((item) => item.id === book.output.id);
    expect(row).toBeDefined();
    if (!row) throw new Error("Synthetic Cookbook was not listed");
    expect(fieldValueOf(row.fields.recipeCount)).toBe(0);
    expect(fieldValueOf(row.fields.sourceRecipeCount)).toBe(1);
    expect(fieldValueOf(row.fields.needsReextract)).toBe(false);
    expect(row).not.toHaveProperty("recipeCount");
    expect(row).not.toHaveProperty("sourceRecipeCount");
    expect(row).not.toHaveProperty("coverUrl");

    const updated = await cookbookHandlers.operations.update({
      data: {
        id: book.output.id,
        data: { name: "Synthetic renamed cookbook" },
      },
      request: request(),
    });
    if (!updated.ok) throw new Error(updated.error.message);
    expect(updated.ok).toBe(true);
    expect(updated.data).toEqual({ id: book.output.id });
    const afterUpdate = await cookbookHandlers.operations.list({
      data: null,
      request: request(),
    });
    if (!afterUpdate.ok) throw new Error(afterUpdate.error.message);
    const renamed = afterUpdate.data.find((row) => row.id === book.output.id);
    expect(renamed?.name).toBe("Synthetic renamed cookbook");
    expect(renamed && fieldValueOf(renamed.fields.recipeCount)).toBe(0);

    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic physical cookbook" }),
      ctx.actor,
    );
    const linked = await recipeHandlers.operations.setCookbookProduct({
      data: { cookbookId: book.output.id, productId: product.id },
      request: request(),
    });
    if (!linked.ok) throw new Error(linked.error.message);
    expect(linked.ok).toBe(true);
    expect(linked.data.product).toEqual({
      id: product.id,
      name: "Synthetic physical cookbook",
      coverUrl: null,
    });
    expect(fieldValueOf(linked.data.fields.sourceRecipeCount)).toBe(1);
    expect(linked.data).not.toHaveProperty("productId");
    expect(linked.data).not.toHaveProperty("recipeCount");
    expect(await getCookbookSource(ctx.db, book.entityId)).toEqual({
      ...sourceBefore,
      name: "Synthetic renamed cookbook",
    });
  });
});
