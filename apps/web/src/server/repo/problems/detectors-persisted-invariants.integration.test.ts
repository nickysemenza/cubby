import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { productComponent } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { findPersistedInvariantViolations } from "./detectors-persisted-invariants";

describe("persisted invariant Problems detector", () => {
  const ctx = withTestDb();

  it("reports rows written around repositories with concise issue paths", async () => {
    const parent = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Fixture parent kit" }),
      ctx.actor,
    );
    const component = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Fixture component" }),
      ctx.actor,
    );
    const [inserted] = await getDb(ctx.db)
      .insert(productComponent)
      .values({
        parentProductId: parent.entityId,
        componentProductId: component.entityId,
        quantity: 1,
      })
      .returning({ id: productComponent.id });
    if (!inserted) throw new Error("fixture component row was not inserted");

    // Deliberately bypass the relation repository to simulate a buggy migration
    // or exceptional out-of-band write after the domain CHECK is removed.
    await getDb(ctx.db)
      .update(productComponent)
      .set({ quantity: 0 })
      .where(eq(productComponent.id, inserted.id));

    const violations = await findPersistedInvariantViolations(ctx.db);
    expect(violations).toEqual([
      expect.objectContaining({
        table: "ProductComponent",
        recordId: inserted.id,
        owner: { entity: "product", id: parent.id },
        issues: [expect.objectContaining({ path: "quantity" })],
      }),
    ]);
  });
});
