import { testShortcode } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { previewOperation } from "./entity-integrity-preview.server";

describe("entityIntegrity.previewOperation", () => {
  const ctx = withTestDb();

  it("reports unresolved attach targets instead of planning over nothing", async () => {
    const parentId = testShortcode("product", "PRD-ZZZZ");
    const productId = testShortcode("product", "PRD-ZZZY");
    const result = await previewOperation(
      ctx.db,
      {
        operation: "attach",
        entity: "product",
        parentId,
        productIds: [productId],
      },
      new Date(),
    );

    expect(result.canProceed).toBe(false);
    expect(result.operation).toBe("attach");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: "block-unresolved-target",
        byTargetId: { "PRD-ZZZZ": 1, "PRD-ZZZY": 1 },
      }),
    );
  });
});
