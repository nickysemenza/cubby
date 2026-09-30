import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { createRecipeFixture, makeRecipeInput } from "../repo.fixtures";
import { getRecipeByShortcode, recipeList, updateRecipe } from "./crud";

const ctx = withTestDb();

// Stored servings must stay nullable: resolving a yield is a read, not an edit.
it("reports live recipe serving fallback without materializing it during reads or reset", async () => {
  const created = await createRecipeFixture(
    ctx.db,
    {
      ...makeRecipeInput({ name: "Synthetic serving resolution" }),
      servings: null,
      yield: { value: 4, unit: "servings" },
    },
    ctx.actor,
  );
  const read = () => getRecipeByShortcode(ctx.db, created.id);
  expect((await read())?.servings).toBeNull();
  expect((await read())?.fieldResolutions?.servings).toMatchObject({
    mode: "inherit",
    storedValue: null,
    value: 4,
    fallbackValue: 4,
    canReset: false,
  });
  const listed = await recipeList(
    ctx.db,
    { nameFilter: "Synthetic serving resolution" },
    [],
    { pageIndex: 0, pageSize: 10 },
  );
  expect(
    listed.data.find((row) => row.id === created.id)?.fieldResolutions
      ?.servings,
  ).toMatchObject({ mode: "inherit", value: 4 });
  await updateRecipe(ctx.db, created.entityId, { servings: 2 }, ctx.actor);
  expect((await read())?.fieldResolutions?.servings).toMatchObject({
    mode: "explicit",
    storedValue: 2,
    value: 2,
    fallbackValue: 4,
    matchesFallback: false,
    canReset: true,
  });
  await updateRecipe(
    ctx.db,
    created.entityId,
    { yield: { value: 2, unit: "servings" } },
    ctx.actor,
  );
  expect((await read())?.fieldResolutions?.servings).toMatchObject({
    mode: "explicit",
    storedValue: 2,
    fallbackValue: 2,
    matchesFallback: true,
  });
  await updateRecipe(ctx.db, created.entityId, { servings: null }, ctx.actor);
  expect((await read())?.servings).toBeNull();
  expect((await read())?.fieldResolutions?.servings).toMatchObject({
    mode: "inherit",
    value: 2,
  });
  await updateRecipe(ctx.db, created.entityId, { yield: null }, ctx.actor);
  expect((await read())?.fieldResolutions?.servings).toMatchObject({
    mode: "inherit",
    storedValue: null,
    value: null,
    fallbackValue: null,
  });
  await updateRecipe(
    ctx.db,
    created.entityId,
    { yield: { value: 300, unit: "g" } },
    ctx.actor,
  );
  expect((await read())?.fieldResolutions?.servings).toMatchObject({
    value: null,
    fallbackValue: null,
  });
});
