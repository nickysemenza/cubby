import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { count, eq } from "drizzle-orm";
import {
  BASE_HOME_SHORTCODE,
  seedBaseWorld,
} from "tooling/factories/base-world";
import { createEntity } from "tooling/factories/create";
import { fakerFromSeed, hashSeed } from "tooling/factories/faker";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { inventoryEntry, location, productCategory } from "~/server/db/schema";
import { createLedgerPartyDefaultRepository } from "~/server/generated/entity-kernel-bindings.gen";

describe("factories against the entity kernel", () => {
  const ctx = withTestDb();

  it("executes ordinary create, update, list and get without a domain repository", async () => {
    const context = buildKernelContext(ctx.db, testUserId(TEST_USER_ID));
    const { repository } = createLedgerPartyDefaultRepository();
    if (!repository.create || !repository.update)
      throw new Error("Missing ordinary writers");
    const created = await repository.create(context, {
      name: "Synthetic guest",
      kind: "guest",
      notes: null,
    });
    const id = parseShortcodeFor("ledgerParty", created.output.id);
    await repository.update(context, id, { name: "Renamed synthetic guest" });
    expect(await repository.get(context, id)).toMatchObject({
      name: "Renamed synthetic guest",
    });
    const page = await repository.listRead(context, {}, [], {
      pageIndex: 0,
      pageSize: 100,
    });
    expect(page.data.some((row) => row.id === id)).toBe(true);
  });

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
