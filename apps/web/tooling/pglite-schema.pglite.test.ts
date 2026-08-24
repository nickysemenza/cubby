import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import { productFiltersSchema } from "@cubby/schemas/product";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { pushSchema } from "drizzle-kit/api";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database as CubbyDatabase } from "~/server/db";
import * as schema from "~/server/db/schema";
import { findSearchHits } from "~/server/services/search.service";

const pg = await PGlite.create({ extensions: { pg_trgm, vector } });
const db = drizzle(pg, { schema });

afterAll(async () => {
  await pg.close();
});

beforeAll(async () => {
  await pg.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector;");
  const { apply } = await pushSchema(
    schema,
    db as unknown as Parameters<typeof pushSchema>[1],
    ["public"],
  );
  await apply();
});

const PARENT_PRODUCT_ID = unsafeProductId(
  "33333333-3333-4333-8333-333333333333",
);
const COMPONENT_PRODUCT_ID = unsafeProductId(
  "44444444-4444-4444-8444-444444444444",
);
const LOCATION_ID = unsafeLocationId("55555555-5555-4555-8555-555555555555");

describe("PGlite full Cubby schema", () => {
  it("initializes pg_trgm/vector and runs the production lexical search query", async () => {
    await db.execute(sql`
      INSERT INTO "SearchDocument" (
        id, "entityType", "entityId", shortcode, title, aliases, keywords,
        body, "semanticText", "normalizedText", "searchVector", "sourceHash"
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', 'product',
        '22222222-2222-4222-8222-222222222222', 'PRD-2222', 'Bench Hammer',
        ARRAY['shop hammer'], ARRAY['forged steel'], 'A forged steel bench hammer',
        'A forged steel bench hammer', 'bench hammer forged steel',
        to_tsvector('simple', 'Bench Hammer forged steel'), 'pglite-search-contract'
      )
    `);

    const hits = await findSearchHits(db as unknown as CubbyDatabase, {
      query: "hammer",
      entityTypes: ["product"],
    });
    expect(hits).toEqual([
      expect.objectContaining({
        id: "PRD-2222",
        entityType: "product",
        title: "Bench Hammer",
        matchField: "title",
      }),
    ]);
  });

  it("keeps representative entity filters, reads, updates, and soft deletion aligned with live rows", async () => {
    await db.insert(schema.product).values([
      {
        id: PARENT_PRODUCT_ID,
        shortcode: "PRD-PRNT",
        name: "Kernel Parent",
        manufacturer: "Cubby",
        category: "tools",
      },
      {
        id: COMPONENT_PRODUCT_ID,
        shortcode: "PRD-COMP",
        name: "Kernel Component",
        manufacturer: "Cubby",
        category: "tools",
      },
    ]);

    const filters = productFiltersSchema.parse({
      categoryFilter: ["tools"],
    });
    expect(filters.categoryFilter).toEqual(["tools"]);
    const listed = await db
      .select({ id: schema.product.shortcode, name: schema.product.name })
      .from(schema.product)
      .where(
        and(
          eq(schema.product.category, "tools"),
          isNull(schema.product.deletedAt),
        ),
      )
      .orderBy(asc(schema.product.name));
    expect(listed).toEqual([
      { id: "PRD-COMP", name: "Kernel Component" },
      { id: "PRD-PRNT", name: "Kernel Parent" },
    ]);

    await db
      .update(schema.product)
      .set({ name: "Kernel Parent Updated" })
      .where(eq(schema.product.id, PARENT_PRODUCT_ID));
    const fetched = await db
      .select({ id: schema.product.shortcode, name: schema.product.name })
      .from(schema.product)
      .where(eq(schema.product.shortcode, "PRD-PRNT"));
    expect(fetched).toEqual([
      { id: "PRD-PRNT", name: "Kernel Parent Updated" },
    ]);

    await db
      .update(schema.product)
      .set({ deletedAt: new Date() })
      .where(eq(schema.product.id, COMPONENT_PRODUCT_ID));

    const liveRows = await db
      .select({ shortcode: schema.product.shortcode })
      .from(schema.product)
      .where(
        and(
          eq(schema.product.category, "tools"),
          isNull(schema.product.deletedAt),
        ),
      );
    expect(liveRows).toEqual([{ shortcode: "PRD-PRNT" }]);

    const missing = await db
      .select({ id: schema.product.shortcode })
      .from(schema.product)
      .where(
        and(
          eq(schema.product.shortcode, "PRD-COMP"),
          isNull(schema.product.deletedAt),
        ),
      );
    expect(missing).toEqual([]);
  });

  it("enforces the representative component relation and inventory uniqueness contracts", async () => {
    await db.insert(schema.location).values({
      id: LOCATION_ID,
      shortcode: "LOC-KERNEL",
      name: "Kernel Shelf",
    });
    await db.insert(schema.inventoryEntry).values({
      id: unsafeInventoryId("66666666-6666-4666-8666-666666666666"),
      shortcode: "INV-KERNEL",
      productId: PARENT_PRODUCT_ID,
      locationId: LOCATION_ID,
      amount: { value: 2, unit: "each" },
      placement: "stock",
    });
    await expect(
      db.insert(schema.inventoryEntry).values({
        id: unsafeInventoryId("77777777-7777-4777-8777-777777777777"),
        shortcode: "INV-DUPLICATE",
        productId: PARENT_PRODUCT_ID,
        locationId: LOCATION_ID,
        amount: { value: 1, unit: "each" },
        placement: "stock",
      }),
    ).rejects.toThrow();

    // Use a second live Product because the previous test deliberately
    // soft-deleted PRD-COMP to cover the read lifecycle boundary.
    const relationChildId = unsafeProductId(
      "88888888-8888-4888-8888-888888888888",
    );
    await db.insert(schema.product).values({
      id: relationChildId,
      shortcode: "PRD-RELN",
      name: "Relation Component",
      manufacturer: "Cubby",
      category: "tools",
    });
    await db.insert(schema.productComponent).values({
      id: "99999999-9999-4999-8999-999999999999",
      parentProductId: PARENT_PRODUCT_ID,
      componentProductId: relationChildId,
      quantity: 2,
    });
    await expect(
      db.insert(schema.productComponent).values({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        parentProductId: PARENT_PRODUCT_ID,
        componentProductId: PARENT_PRODUCT_ID,
        quantity: 1,
      }),
    ).rejects.toThrow();

    const edges = await db
      .select({ quantity: schema.productComponent.quantity })
      .from(schema.productComponent)
      .where(
        and(
          eq(schema.productComponent.parentProductId, PARENT_PRODUCT_ID),
          isNull(schema.productComponent.deletedAt),
        ),
      );
    expect(edges).toEqual([{ quantity: 2 }]);
  });
});
