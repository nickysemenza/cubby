import { testShortcode } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { listProductComponents } from "~/server/repo/product-components";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { previewOperation } from "./entity-integrity-preview.server";

describe("entityIntegrity.previewOperation", () => {
  const ctx = withTestDb();

  it("returns public attach impacts without writing component links", async () => {
    const parent = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Preview tool kit" }),
      ctx.actor,
    );
    const child = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Preview battery" }),
      ctx.actor,
    );
    const now = new Date("2026-09-09T12:00:00.000Z");
    const result = await previewOperation(
      ctx.db,
      {
        action: "attach",
        entity: "product",
        relation: "components",
        id: parent.id,
        items: [{ id: child.id }],
      },
      now,
    );

    expect(result.canProceed).toBe(true);
    expect(result.generatedAt).toBe(now.toISOString());
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        byTargetId: { [child.id]: 1 },
      }),
    );
    expect(await listProductComponents(ctx.db, parent.entityId)).toEqual([]);
  });

  it("reports unresolved attach targets instead of planning over nothing", async () => {
    const parentId = testShortcode("product", "PRD-ZZZZ");
    const productId = testShortcode("product", "PRD-ZZZY");
    const result = await previewOperation(
      ctx.db,
      {
        action: "attach",
        entity: "product",
        relation: "components",
        id: parentId,
        items: [{ id: productId }],
      },
      new Date(),
    );

    expect(result.canProceed).toBe(false);
    expect(result.operation).toBe("attach");
    expect(result.relation).toBe("components");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: "block-unresolved-target",
        byTargetId: { "PRD-ZZZZ": 1, "PRD-ZZZY": 1 },
      }),
    );
  });
});
