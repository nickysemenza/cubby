import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import { TEST_ACTOR } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { Database } from "~/server/db/database";
import { mergeIngredients } from "./merge";

/**
 * The self-merge guard is the first statement of `mergeIngredients` — it runs
 * before `getDb(db)` is ever called.
 *
 * This was an integration test that created two rows and then counted
 * survivors to prove the target had not been hard-deleted. Asserting against a
 * `db` that throws on ANY property access is strictly stronger: it proves the
 * rejection happens before the database is touched at all, rather than proving
 * only that the rows happened to survive.
 */
const explodingDb = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(
        `mergeIngredients touched the database (property "${String(prop)}") before rejecting a self-merge`,
      );
    },
  },
) as Database;

describe("mergeIngredients self-merge guard", () => {
  const target = unsafeIngredientId("11111111-1111-4111-8111-111111111111");
  const other = unsafeIngredientId("22222222-2222-4222-8222-222222222222");

  it("rejects merging an ingredient into itself without touching the database", async () => {
    await expect(
      mergeIngredients(explodingDb, target, [target, other], TEST_ACTOR),
    ).rejects.toThrow(/itself/i);
  });

  it("rejects even when the target is the only alias", async () => {
    await expect(
      mergeIngredients(explodingDb, target, [target], TEST_ACTOR),
    ).rejects.toThrow(/itself/i);
  });

  // Guards the guard. Without this, the two tests above would still pass if
  // `mergeIngredients` started rejecting everything for some unrelated reason,
  // or if `explodingDb` silently stopped throwing — both would leave a green
  // test proving nothing. A non-self merge must get PAST the guard and hit the
  // database, which is the proxy's error, not INGREDIENT_MERGE_INVALID.
  it("lets a non-self merge through to the database (proves the harness is live)", async () => {
    await expect(
      mergeIngredients(explodingDb, target, [other], TEST_ACTOR),
    ).rejects.toThrow(/touched the database/i);
  });
});
