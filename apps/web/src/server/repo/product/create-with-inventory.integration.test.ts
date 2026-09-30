import { productCreateInput } from "@cubby/schemas/product";
import { productCreateWithInventoryInput } from "@cubby/schemas/product-capture";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { entityAttachment, image, product } from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  createLocationFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { createProductWithInventory } from "./capture";

// Failure modes: a refused placement leaves a Product or photo association;
// rollback consumes the staged photo; retry stocks two graphs; returned Product
// omits the inventory that committed with it. Real PG is the transaction boundary.
describe("atomic staged-photo Product and Inventory capture", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  type CaptureInput = z.input<typeof productCreateWithInventoryInput>;
  const capture = (input: CaptureInput) =>
    createProductWithInventory(
      context(),
      productCreateWithInventoryInput.parse(input),
    );

  it("keeps the photo staged on a refused placement and commits one graph on explicit retry", async () => {
    const unavailable = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic removed capture shelf" }),
      ctx.actor,
    );
    const available = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic capture shelf" }),
      ctx.actor,
    );
    await executeEntity(context(), {
      action: "delete",
      entity: "location",
      ids: [unavailable.id],
    });
    const staged = await createImageFixture(
      ctx.db,
      "synthetic-staged-capture",
      {
        status: "PENDING",
      },
    );
    const name = "Synthetic photographed capture item";
    const request: CaptureInput = {
      product: productCreateInput.parse(
        makeProductInput({
          name,
          pendingImageIds: [staged.shortcode],
        }),
      ),
      inventory: {
        locationId: unavailable.id,
        placement: "stock",
        amount: { value: 1, unit: "each" },
      },
    };
    await expect(capture(request)).rejects.toThrow(
      /not found|not live|missing/i,
    );
    expect(
      await getDb(ctx.db)
        .select({ id: product.id })
        .from(product)
        .where(and(eq(product.name, name), notDeleted(product))),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityAttachment)
        .where(
          and(
            eq(entityAttachment.imageId, staged.id),
            notDeleted(entityAttachment),
          ),
        ),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ status: image.status })
        .from(image)
        .where(eq(image.id, staged.id)),
    ).toEqual([{ status: "PENDING" }]);
    const beforeRetry = await getDb(ctx.db).execute(sql`
      SELECT count(*)::int AS count FROM "InventoryEntry" WHERE "deletedAt" IS NULL
    `);
    expect(beforeRetry.rows).toEqual([{ count: 0 }]);

    const captured = await capture({
      ...request,
      inventory: { ...request.inventory, locationId: available.id },
    });
    const graph = await getDb(ctx.db).execute(sql`
      SELECT (SELECT count(*)::int FROM "Product" WHERE name = ${name} AND "deletedAt" IS NULL) AS products,
        (SELECT count(*)::int FROM "InventoryEntry" WHERE "deletedAt" IS NULL) AS inventory,
        (SELECT count(*)::int FROM "EntityAttachment" WHERE "imageId" = ${staged.id} AND "deletedAt" IS NULL) AS attachments
    `);
    expect(graph.rows).toEqual([{ products: 1, inventory: 1, attachments: 1 }]);
    expect(captured.product.inventoryEntry.map((entry) => entry.id)).toEqual([
      captured.inventory.id,
    ]);
    expect(captured.product.images.map((entry) => entry.id)).toEqual([
      staged.shortcode,
    ]);
    expect(captured.inventory.product.id).toBe(captured.product.id);
    expect(captured.inventory.location.id).toBe(available.id);
    expect(
      await getDb(ctx.db)
        .select({ status: image.status })
        .from(image)
        .where(eq(image.id, staged.id)),
    ).toEqual([{ status: "UPLOADED" }]);
  });
});
