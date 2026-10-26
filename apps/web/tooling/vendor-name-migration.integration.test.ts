import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("retains Vendor evidence and Product references when enforcing live names", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0037_derived_values" });
    const live = "00000000-0000-4000-8000-000000000011";
    const retired = "00000000-0000-4000-8000-000000000012";
    const product = "00000000-0000-4000-8000-000000000013";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES
      ($1,'vendor','VEN-SYNTHETICLIVE'),($2,'vendor','VEN-SYNTHETICOLD'),
      ($3,'product','PRD-SYNTHETIC')`,
      [live, retired, product],
    );
    await client.query(
      `INSERT INTO "Vendor" (id,shortcode,name,aliases,notes,"deletedAt") VALUES
      ($1,'VEN-SYNTHETICLIVE','Synthetic maker',ARRAY['Synthetic alias'],'Retained member notes',NULL),
      ($2,'VEN-SYNTHETICOLD',' SYNTHETIC MAKER ','{}','Retained historical notes','2025-01-01')`,
      [live, retired],
    );
    await client.query(
      `INSERT INTO "Product" (id,shortcode,name,"brandId") VALUES
      ($1,'PRD-SYNTHETIC','Synthetic retained item',$2)`,
      [product, live],
    );
    const vendors = await client.query(`SELECT * FROM "Vendor" ORDER BY id`);
    const products = await client.query(`SELECT * FROM "Product" ORDER BY id`);
    await migrateDatabase(db, { through: "0038_unique_live_vendor_names" });
    expect(
      (await client.query(`SELECT * FROM "Vendor" ORDER BY id`)).rows,
    ).toEqual(vendors.rows);
    expect(
      (await client.query(`SELECT * FROM "Product" ORDER BY id`)).rows,
    ).toEqual(products.rows);
    await expect(
      client.query(`UPDATE "Vendor" SET "deletedAt"=NULL WHERE id=$1`, [
        retired,
      ]),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "Vendor_name_live_key",
    });
  });
});
