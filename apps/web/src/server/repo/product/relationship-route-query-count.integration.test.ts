import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getEntityGraph } from "~/server/repo/entity-graph";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

describe("product entity graph query budget", () => {
  const ctx = withTestDb();

  it("keeps the unfiltered product graph within its batching budget", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Relationship query budget" }),
      ctx.actor,
    );

    const result = await countTestDbQueries(() =>
      getEntityGraph(ctx.db, {
        roots: [{ entityType: "product", entityId: product.id }],
      }),
    );

    expect(result.queryCount).toBeLessThanOrEqual(8);
  });
});
