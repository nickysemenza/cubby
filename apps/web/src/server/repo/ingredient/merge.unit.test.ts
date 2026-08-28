import { testShortcode } from "@cubby/schemas/testing";
import { TEST_ACTOR } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { Database } from "~/server/db/database";

import { mergeIngredients } from "./merge";

/**
 * The self-merge guard is the first thing `mergeIngredients` reaches —
 * `resolveMergeTargets` checks the SHORTCODES before it resolves any of them,
 * so the rejection happens before `getDb(db)` is ever called.
 *
 * This was an integration test that created two rows and then counted
 * survivors to prove the target had not been hard-deleted. Asserting against a
 * `db` that throws on ANY property access is strictly stronger: it proves the
 * rejection happens before the database is touched at all, rather than proving
 * only that the rows happened to survive.
 */
const explodingDb = new Database(() => {
  throw new Error("mergeIngredients touched the database before rejecting");
});

describe("mergeIngredients self-merge guard", () => {
  const keepId = testShortcode("ingredient", "ING-AAAA");
  const other = testShortcode("ingredient", "ING-BBBB");

  it("rejects merging an ingredient into itself without touching the database", async () => {
    await expect(
      mergeIngredients(
        explodingDb,
        { keepId, mergeIds: [keepId, other] },
        TEST_ACTOR,
      ),
    ).rejects.toMatchObject({ cause: { reason: "MERGE_SELF_REFERENCE" } });
  });

  it("rejects even when the keeper is the only id to merge away", async () => {
    await expect(
      mergeIngredients(explodingDb, { keepId, mergeIds: [keepId] }, TEST_ACTOR),
    ).rejects.toMatchObject({ cause: { reason: "MERGE_SELF_REFERENCE" } });
  });

  // Guards the guard. Without this, the two tests above would still pass if
  // `mergeIngredients` started rejecting everything for some unrelated reason,
  // or if `explodingDb` silently stopped throwing — both would leave a green
  // test proving nothing. A non-self merge must get PAST the guard and hit the
  // database, which is the proxy's error, not MERGE_SELF_REFERENCE.
  it("lets a non-self merge through to the database (proves the harness is live)", async () => {
    await expect(
      mergeIngredients(explodingDb, { keepId, mergeIds: [other] }, TEST_ACTOR),
    ).rejects.toThrow(/touched the database/i);
  });
});
