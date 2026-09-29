import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  findProblemCounts,
  findUpcProblems,
} from "~/server/services/problems.service";

import { createProductFixture, makeProductInput } from "./repo.fixtures";

// The count snapshot behind the navbar badge must not depend on an external
// UPC provider: the `upc` lane is skipped and its key stays 0, while the
// Problems page still loads the lane through `findUpcProblems`.
describe("problem counts and the UPC lane", () => {
  const ctx = withTestDb();

  it("never calls the UPC provider for the count snapshot", async () => {
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "UPC count test good", upc: "036000291452" }),
      ctx.actor,
    );
    const lookupBatch = vi.fn(async () => new Map());
    const client = { lookupBatch };

    const counts = await findProblemCounts(ctx.db, client);

    expect(lookupBatch).not.toHaveBeenCalled();
    expect(counts.byType.productsWithBetterUpcData).toBe(0);

    // Control: the page-side lane does reach the provider for the same data.
    await findUpcProblems(ctx.db, client);
    expect(lookupBatch).toHaveBeenCalled();
  });
});
