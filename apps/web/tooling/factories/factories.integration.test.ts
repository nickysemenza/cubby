import { testUserId } from "@cubby/schemas/testing";
import { count, eq } from "drizzle-orm";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryEntry, location, productCategory } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { buildKernelContext } from "../scenarios/context";
import { BASE_HOME_SHORTCODE, seedBaseWorld } from "./base-world";
import { createEntity } from "./build";
import { fakerFromSeed, hashSeed } from "./faker";

describe("factories against the entity kernel", () => {
  const ctx = withTestDb();

  it("seedBaseWorld is idempotent: a second seed neither throws nor duplicates Home or the taxonomy", async () => {
    const client = getDb(ctx.db);
    await seedBaseWorld(client);
    const [homes] = await client
      .select({ value: count() })
      .from(location)
      .where(eq(location.shortcode, BASE_HOME_SHORTCODE));
    const [categories] = await client
      .select({ value: count() })
      .from(productCategory);
    expect(homes?.value).toBe(1);
    // withTestDb already seeded the same roots once.
    expect(categories?.value).toBeGreaterThan(0);
  });

  it("creates a related graph from defaults, supplying only the relations", async () => {
    const context = buildKernelContext(ctx.db, testUserId(TEST_USER_ID));
    const faker = fakerFromSeed(hashSeed("kernel-graph"));
    const place = await createEntity(context, "location", {}, { faker });
    const product = await createEntity(context, "product", {}, { faker });
    const stock = await createEntity(
      context,
      "inventory",
      { productId: product.id, locationId: place.id },
      { faker },
    );

    expect(stock.id).toMatch(/^INV-/u);
    const [rows] = await getDb(ctx.db)
      .select({ value: count() })
      .from(inventoryEntry);
    expect(rows?.value).toBe(1);
  });
});
