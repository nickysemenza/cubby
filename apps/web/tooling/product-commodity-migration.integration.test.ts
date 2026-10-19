import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Adding `Product.commodity` must keep every existing Product exactly as it
// was and default it to false, and the Worker still deployed while the
// migration applies inserts Products without naming the column.
it("adds Product.commodity without changing existing Products", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const index = tags.findIndex((tag) => tag.endsWith("_product_commodity"));
    if (index < 1) throw new Error("Product commodity has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[index - 1]! });
    await client.query(
      `INSERT INTO "Product" (shortcode, name, manufacturer, model, price)
       VALUES ('PRD-4K7M', 'Synthetic lemons', 'generic', NULL, 2.5),
              ('PRD-7M4K', 'Synthetic drill', 'Acme', 'EX-100', NULL)`,
    );
    const products = async () =>
      (
        await client.query(
          `SELECT to_jsonb(p) - 'commodity' AS data FROM "Product" p ORDER BY shortcode`,
        )
      ).rows;
    const before = await products();

    await migrateDatabase(drizzle(client), { through: tags[index]! });

    expect(await products()).toEqual(before);
    const flags = await client.query(
      `SELECT shortcode, commodity FROM "Product" ORDER BY shortcode`,
    );
    expect(flags.rows).toEqual([
      { shortcode: "PRD-4K7M", commodity: false },
      { shortcode: "PRD-7M4K", commodity: false },
    ]);
    // The predecessor Worker's column list omits `commodity`.
    await client.query(
      `INSERT INTO "Product" (shortcode, name, manufacturer)
       VALUES ('PRD-K7M4', 'Synthetic garlic', '(unspecified)')`,
    );
    const inserted = await client.query(
      `SELECT commodity FROM "Product" WHERE shortcode = 'PRD-K7M4'`,
    );
    expect(inserted.rows).toEqual([{ commodity: false }]);
  });
});
