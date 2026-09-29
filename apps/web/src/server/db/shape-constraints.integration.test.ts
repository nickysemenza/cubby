import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

/**
 * Value-set columns that used to be pgEnums are text with a CHECK built from
 * the `packages/schemas` value arrays (`enumCheck` in schema.ts). The database
 * must keep refusing a value outside the set, whichever path writes it.
 */
describe("text + CHECK value sets", () => {
  const ctx = withTestDb();

  it("refuses Image status values outside the declared sets", async () => {
    const image = await createImageFixture(ctx.db, "shape-check");
    for (const [column, constraint] of [
      ["status", "Image_status_check"],
      ["renderStatus", "Image_renderStatus_check"],
      ["storageStatus", "Image_storageStatus_check"],
    ] as const) {
      await expect(
        getDb(ctx.db).execute(
          sql`UPDATE "Image" SET ${sql.identifier(column)} = 'bogus' WHERE id = ${image.id}`,
        ),
      ).rejects.toMatchObject({ cause: { constraint } });
    }
    await getDb(ctx.db).execute(
      sql`UPDATE "Image" SET "renderStatus" = 'verified', "storageStatus" = 'available' WHERE id = ${image.id}`,
    );
  });

  it("refuses an InventoryEntry placement outside stock/installed", async () => {
    const [sku, shelf] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Placement check" }),
        ctx.actor,
      ),
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Placement shelf", type: "shelf" }),
        ctx.actor,
      ),
    ]);
    const entry = await createInventoryFixture(
      ctx.db,
      {
        productId: sku.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await expect(
      getDb(ctx.db).execute(
        sql`UPDATE "InventoryEntry" SET placement = 'buried' WHERE id = ${entry.entityId}`,
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "InventoryEntry_placement_check" },
    });
  });
});
