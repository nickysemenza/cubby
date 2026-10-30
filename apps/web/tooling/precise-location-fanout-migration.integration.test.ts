import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves retained publications and input identities across precise fanout migrations", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0059_sender_attribution_policies" });
    const id = "00000000-0000-4000-8000-000000000001";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'product','PRD-SYNTHETIC')`,
      [id],
    );
    await client.query(
      `INSERT INTO "Product" (id,shortcode,name) VALUES ($1,'PRD-SYNTHETIC','Synthetic retained product')`,
      [id],
    );
    await client.query(
      `INSERT INTO "DerivedValue" ("entityId",kind,key,value,"computedAt") VALUES ($1,'product','readFacts','{"retained":"synthetic"}',now())`,
      [id],
    );
    await client.query(
      `SELECT derived_mark('product.readFacts@44', ARRAY[$1::uuid])`,
      [id],
    );
    const preserved = async () => ({
      work: (
        await client.query(
          `SELECT to_jsonb(w) value FROM "WorkItem" w ORDER BY target,ref`,
        )
      ).rows,
      publications: (
        await client.query(
          `SELECT to_jsonb(v) value FROM "DerivedValue" v ORDER BY "entityId",key`,
        )
      ).rows,
      products: (
        await client.query(
          `SELECT to_jsonb(p) value FROM "Product" p ORDER BY id`,
        )
      ).rows,
    });
    const before = await preserved();
    await migrateDatabase(db, { through: "0060_precise_location_fanout" });
    expect(await preserved()).toEqual(before);
    // A deleted SourceOrder can leave its UUID ticket owed to the predecessor expansion.
    await client.query(
      `SELECT derived_mark('email.relationshipFacts@8', ARRAY[$1::uuid])`,
      [id],
    );
    await client.query(
      `UPDATE "WorkItem" SET priority=2, attempts=1, "readyAt"=now()+interval '1 day' WHERE target='email.relationshipFacts@8'`,
    );
    const beforeSourceOrder = await preserved();
    await migrateDatabase(db, { through: "0061_source_order_purchase_fanout" });
    expect(await preserved()).toEqual(beforeSourceOrder);
    const definition = (
      await client.query(
        `SELECT pg_get_functiondef('derived_mark_importsourceorder()'::regprocedure) AS value`,
      )
    ).rows[0]?.value;
    expect(definition).toContain("derived_mark('email.relationshipFacts@9'");
    expect(definition).not.toContain(
      "derived_mark('email.relationshipFacts@8'",
    );
  });
});
