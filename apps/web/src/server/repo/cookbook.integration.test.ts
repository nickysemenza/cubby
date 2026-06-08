import type { ActorContext } from "@cubby/schemas/context";
import type { CookbookRecipe } from "@cubby/schemas/cookbook";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { recipe } from "~/server/db/schema";
import {
  getCookbookByName,
  listCookbooks,
  reprocessCookbook,
  upsertCookbook,
} from "./cookbook";
import { getDb } from "./database-helpers";
import { insertCookbookRecipe } from "./recipe";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "epub_import",
};

// A raw CookbookRecipe (the parser's shape; lines parsed server-side on import).
const cookbookRecipe = (
  title: string,
  ingredients: string[],
): CookbookRecipe => ({
  meta: { title },
  sections: [{ ingredients, instructions: [] }],
  references: [],
});

describe("cookbook repository", () => {
  let db: Database;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
    return teardown;
  });

  it("upsertCookbook creates then updates by name (no duplicate)", async () => {
    const raw = [cookbookRecipe("Pancakes", ["2 cups flour"])];
    const first = await upsertCookbook(
      db,
      { name: "Book A", rawJson: raw, author: ["Ada"], sourceLabel: "a.epub" },
      TEST_ACTOR,
    );
    const second = await upsertCookbook(
      db,
      {
        name: "Book A",
        rawJson: raw,
        author: ["Ada", "Bob"],
        subjects: ["Baking"],
        sourceLabel: "a.epub",
      },
      TEST_ACTOR,
    );

    expect(second.id).toBe(first.id);
    const cb = await getCookbookByName(db, "Book A");
    expect(cb?.author).toEqual(["Ada", "Bob"]);
    expect(cb?.subjects).toEqual(["Baking"]);
    expect(cb?.rawJson).toHaveLength(1);
  });

  it("listCookbooks reports the live, non-deleted recipe count", async () => {
    const raw = [
      cookbookRecipe("Pancakes", ["2 cups flour"]),
      cookbookRecipe("Waffles", ["1 cup flour"]),
    ];
    const { id } = await upsertCookbook(
      db,
      { name: "Book A", rawJson: raw, sourceLabel: "a.epub" },
      TEST_ACTOR,
    );
    const ref = { id, name: "Book A" };
    await insertCookbookRecipe(raw[0], ref, db, TEST_ACTOR);

    const list = await listCookbooks(db);
    const entry = list.find((c) => c.id === id);
    expect(entry).toBeDefined();
    // Only one of the two raw recipes was actually imported.
    expect(entry?.recipeCount).toBe(1);
  });

  it("reprocessCookbook re-derives imported recipes and flags unimported extras", async () => {
    const raw = [
      cookbookRecipe("Pancakes", ["2 cups flour"]),
      cookbookRecipe("Waffles", ["1 cup flour"]),
    ];
    const { id } = await upsertCookbook(
      db,
      { name: "Book A", rawJson: raw, sourceLabel: "a.epub" },
      TEST_ACTOR,
    );
    const ref = { id, name: "Book A" };

    // Import only the first recipe (the user's selection).
    const imported = await insertCookbookRecipe(raw[0], ref, db, TEST_ACTOR);

    const result = await reprocessCookbook(db, id, TEST_ACTOR);

    // Pancakes was re-derived; Waffles (never imported) is surfaced, not created.
    expect(result.reprocessed).toBe(1);
    expect(result.importableExtras).toEqual(["Waffles"]);

    // Reprocess upserts in place — no duplicate, same id.
    const pancakes = await getDb(db).query.recipe.findMany({
      where: eq(recipe.name, "Pancakes"),
    });
    expect(pancakes).toHaveLength(1);
    expect(pancakes[0]!.id).toBe(imported.id);
    expect(pancakes[0]!.cookbookId).toBe(id);

    // Waffles stayed unimported.
    const waffles = await getDb(db).query.recipe.findMany({
      where: eq(recipe.name, "Waffles"),
    });
    expect(waffles).toHaveLength(0);
  });
});
