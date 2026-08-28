import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { getProductRelationshipRoute } from "./relationship-route";

describe("getProductRelationshipRoute query budget", () => {
  const ctx = withTestDb();

  it("stays within the repository and shortcode-resolved operation ceilings", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Relationship query budget" }),
      ctx.actor,
    );

    // Baseline before consolidation: 16 repository statements, 17 including
    // shortcode resolution. The fixed reads remain independent while purchase,
    // project, and vendor previews now each own one bounded statement.
    const repository = await countTestDbQueries(() =>
      getProductRelationshipRoute(ctx.db, product.entityId),
    );
    const operation = await countTestDbQueries(async () =>
      getProductRelationshipRoute(
        ctx.db,
        await resolveOrThrow(ctx.db, "product", product.id),
      ),
    );

    expect(repository.queryCount).toBeLessThanOrEqual(8);
    expect(operation.queryCount).toBeLessThanOrEqual(9);
  });
});
