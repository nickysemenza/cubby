import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getRecipeByID, updateRecipe } from "~/server/repo/recipe";

import { updateCookbook, upsertCookbook } from "./cookbook";
import {
  createRecipeFixture,
  makeCookbookExtraction,
  makeRecipeInput,
} from "./repo.fixtures";

describe("cookbook edits and recipe re-pointing", () => {
  const ctx = withTestDb();
  const makeBook = (name: string) =>
    upsertCookbook(
      ctx.db,
      {
        name,
        rawJson: makeCookbookExtraction([]),
        sourceLabel: `${name}.epub`,
      },
      ctx.actor,
    );

  it("retitles a cookbook and refuses a title another live cookbook holds", async () => {
    const first = await makeBook("Edit book one");
    const second = await makeBook("Edit book two");

    const renamed = await updateCookbook(ctx.db, ctx.actor, first.output.id, {
      name: "Edit book uno",
      author: ["Ada Author"],
      subjects: ["Baking"],
    });
    expect(renamed.output).toMatchObject({
      book: "Edit book uno",
      author: ["Ada Author"],
      subjects: ["Baking"],
    });

    await expect(
      updateCookbook(ctx.db, ctx.actor, second.output.id, {
        name: "Edit book uno",
      }),
    ).rejects.toThrow(/already used by/);
  });

  it("moves a recipe into a cookbook as a Book recipe and out again", async () => {
    const book = await makeBook("Move book");
    const plain = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Move me" }),
      ctx.actor,
    );

    await updateRecipe(
      ctx.db,
      plain.entityId,
      { cookbookId: book.output.id },
      ctx.actor,
    );
    const inBook = await getRecipeByID(ctx.db, plain.entityId);
    expect(inBook?.source).toMatchObject({
      type: "book",
      book: "Move book",
      cookbookId: book.output.id,
    });

    await updateRecipe(ctx.db, plain.entityId, { cookbookId: null }, ctx.actor);
    const out = await getRecipeByID(ctx.db, plain.entityId);
    expect(out?.source).toEqual({ type: "other" });
  });

  it("names the holder when the target cookbook already has that title, or leaving would collide", async () => {
    const book = await makeBook("Collide book");
    const inBook = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Same title" }),
      ctx.actor,
    );
    await updateRecipe(
      ctx.db,
      inBook.entityId,
      { cookbookId: book.output.id },
      ctx.actor,
    );
    // Book recipes are exempt from the global name index, so this is allowed.
    const twin = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Same title" }),
      ctx.actor,
    );

    await expect(
      updateRecipe(
        ctx.db,
        twin.entityId,
        { cookbookId: book.output.id },
        ctx.actor,
      ),
    ).rejects.toThrow(/already has a recipe named "Same title"/);
    await expect(
      updateRecipe(ctx.db, inBook.entityId, { cookbookId: null }, ctx.actor),
    ).rejects.toThrow(/same name as/);
  });
});
