import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { prepareProductConversionCoveragePage } from "./problems.service";

// Provider preparation may outlive a product edit. It cannot stamp that edit's
// projection fresh using the older mappings or pricing snapshot.
describe("conversion refresh publication", () => {
  const ctx = withTestDb();
  it("rejects a prepared page whose authoritative source changed", async () => {
    const saved = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic coverage" }),
      ctx.actor,
    );
    const prepared = await prepareProductConversionCoveragePage(
      ctx.db,
      { limit: 25 },
      { findFoodsBatch: async (lookups) => lookups.map(() => null) },
    );
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic revised coverage" })
      .where(eq(product.id, saved.entityId));
    await expect(
      withTransactionDatabase(ctx.db, prepared.publish),
    ).rejects.toThrow("Conversion inputs changed");
  });
});
