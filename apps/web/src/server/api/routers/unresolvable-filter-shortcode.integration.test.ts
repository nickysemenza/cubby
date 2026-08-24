import {
  unsafeCookbookShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { SHORTCODE_PREFIX, UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { seedFromCSV, TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  createRecipeFixture,
  listParams,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { inventoryRouter } from "./inventory";
import { recipeRouter } from "./recipe";

const unresolvable = (entity: keyof typeof SHORTCODE_PREFIX) =>
  `${SHORTCODE_PREFIX[entity]}9999`;

/**
 * Resolution for these three filters moved out of the routers and into
 * `inventoryentryList` / `recipeList` (see `resolveFilterIds`). That is a
 * BEHAVIOR CHANGE, and this is its sole coverage: the routers used
 * `resolveOrThrow` / `resolveAllOrThrow`, so a filter naming a dead code 404'd
 * the whole page. Filter semantics say a requested-but-unresolved id matches
 * nothing (CLAUDE.md, Renderers / saved views / scopes), so the repos use
 * `resolveAllPresent` and the list comes back EMPTY instead.
 *
 * Empty and not merely "not a 404": the failure mode being guarded against is
 * an unapplied constraint silently widening to the unfiltered table, which is
 * why each case asserts a non-zero baseline first.
 */
describe("a list filter naming an unresolvable shortcode matches nothing", () => {
  const ctx = withTestDb();

  const seedInventory = () =>
    seedFromCSV(
      ctx.db,
      [
        {
          product_name: "Flour",
          location_name: "Pantry",
          quantity: 2,
          unit: "lbs",
        },
      ],
      TEST_ACTOR,
    );

  it.each([
    ["locationIdFilter", "location", unsafeLocationShortcode],
    ["productIdFilter", "product", unsafeProductShortcode],
  ] as const)("inventory.%s", async (field, entity, brand) => {
    const caller = createTestCaller(inventoryRouter, ctx.db);
    await seedInventory();

    expect((await caller.list(listParams())).meta.totalCount).toBeGreaterThan(
      0,
    );

    const filtered = await caller.list(
      listParams({ filters: { [field]: brand(unresolvable(entity)) } }),
    );
    expect(filtered.items).toEqual([]);
    expect(filtered.meta.totalCount).toEqual(0);
  });

  it("recipe.cookbookId", async () => {
    const caller = createTestCaller(recipeRouter, ctx.db);
    await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Pantry loaf" }),
      TEST_ACTOR,
    );

    expect((await caller.list(listParams())).meta.totalCount).toBeGreaterThan(
      0,
    );

    const filtered = await caller.list(
      listParams({
        filters: {
          cookbookId: unsafeCookbookShortcode(unresolvable("cookbook")),
        },
      }),
    );
    expect(filtered.items).toEqual([]);
    expect(filtered.meta.totalCount).toEqual(0);
  });

  it("preserves a malformed route filter as an empty inventory cohort", async () => {
    const caller = createTestCaller(inventoryRouter, ctx.db);
    await seedInventory();

    const filtered = await caller.list(
      listParams({
        filters: { productIdFilter: UNRESOLVABLE_ENTITY_FILTER },
      }),
    );
    expect(filtered.items).toEqual([]);
    expect(filtered.meta.totalCount).toEqual(0);
  });

  it("preserves a malformed route filter as an empty relationship cohort", async () => {
    const caller = createTestCaller(recipeRouter, ctx.db);
    await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Route-filter loaf" }),
      TEST_ACTOR,
    );

    const filtered = await caller.list(
      listParams({
        filters: { cookbookId: UNRESOLVABLE_ENTITY_FILTER },
      }),
    );
    expect(filtered.items).toEqual([]);
    expect(filtered.meta.totalCount).toEqual(0);
  });
});
