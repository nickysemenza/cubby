import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("projects retained connection targets without rewriting evidence or review state", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0041_unclassified_principal_product_gaps",
    });
    const record = "00000000-0000-4000-8000-000000000001";
    const id = "00000000-0000-4000-8000-000000000002";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'product','PRD-SYNTHETIC')`,
      [record],
    );
    await client.query(
      `INSERT INTO "Product" (id,shortcode,name) VALUES ($1,'PRD-SYNTHETIC','Synthetic retained connection source')`,
      [record],
    );
    const target = { entityKind: "expense", entityId: "EXP-SYNTHETIC" };
    await client.query(
      `INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,evidence,served)
      VALUES ($1,'synthetic-connection','recommendation',$2::jsonb,'{"candidateKey":"synthetic-key"}',$3::jsonb,true)`,
      [
        id,
        JSON.stringify({
          kind: "recommendation",
          entity: "product",
          recordId: record,
          scope: "connection.product-expense",
          candidateKey: "synthetic-key",
        }),
        JSON.stringify({
          candidate: { target },
          basis: { note: "Synthetic retained evidence" },
        }),
      ],
    );
    await client.query(
      `INSERT INTO "AssessmentState" (id,family,entity,"recordId",active,status,data)
      VALUES ($1,'recommendation','product',$2,true,'pending','{"connection":true,"retained":"synthetic"}')`,
      [id, record],
    );
    const immutable = async () =>
      (
        await client.query(
          `SELECT to_jsonb(a) AS value FROM "Assessment" a WHERE id=$1`,
          [id],
        )
      ).rows;
    const review = async () =>
      (
        await client.query(
          `SELECT to_jsonb(s)-'data' AS value,
      data-'connectionTarget' AS data FROM "AssessmentState" s WHERE id=$1`,
          [id],
        )
      ).rows;
    const before = { immutable: await immutable(), review: await review() };
    await migrateDatabase(db, { through: "0042_connection_target_projection" });
    expect(await immutable()).toEqual(before.immutable);
    expect(await review()).toEqual(before.review);
    expect(
      (
        await client.query(
          `SELECT data->'connectionTarget' AS target FROM "AssessmentState" WHERE id=$1`,
          [id],
        )
      ).rows,
    ).toEqual([{ target }]);
  });
});
