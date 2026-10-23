import { productCreateManyInput } from "@cubby/schemas/product";
import { productCreateManyEvent } from "@cubby/schemas/product-workflow";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  getVendorByID,
  findOrCreateVendor,
} from "~/server/domains/vendor/repo/vendor";
import { requireActor } from "~/server/http/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { createManyProductsWorkflow } from "./product.server";

describe("product bulk workflow", () => {
  const ctx = withTestDb();

  it("streams validated progress and its final committed result", async () => {
    const prefix = `Bulk workflow ${Date.now()}`;
    const fixtureBrandId = (
      await getVendorByID(
        ctx.db,
        await findOrCreateVendor(ctx.db, "Fixture Brand"),
      )
    ).id;
    const input = productCreateManyInput.parse(
      ["One", "Two"].map((suffix) => ({
        name: `${prefix} ${suffix}`,
        brandId: fixtureBrandId,
        aliases: [],
        tags: [],
        barcode: null,
        fdc_id: null,
        expectedQuantity: null,
        ingredientId: null,
        unitMappings: [],
        externalIds: [],
      })),
    );
    const context = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const events = [];
    for await (const event of createManyProductsWorkflow(context, input)) {
      events.push(productCreateManyEvent.parse(event));
    }
    expect(events.slice(0, -1)).toEqual([
      { type: "progress", done: 0, total: 2 },
      { type: "progress", done: 1, total: 2 },
      { type: "progress", done: 2, total: 2 },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      result: { created: 2, failed: [] },
    });
  });
});
