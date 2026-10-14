import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { testServiceConfig } from "./test-service-config";

// Widening role constraints must preserve historical money and admit unresolved standalone money.
it("preserves existing Expenses while admitting an unresolved receipt role", async () => {
  const service = testServiceConfig();
  const adminUrl = `postgresql://postgres:password@${service.host}:${service.port}/postgres`;
  const name = `cubby_semantic_role_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.href });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await client.connect();
    await migrateDatabase(drizzle(client), { through: "0063_derived_ddl" });
    await client.query(
      `INSERT INTO "Vendor" (shortcode,name) VALUES ('VEN-4K7M','Synthetic merchant')`,
    );
    await client.query(
      `INSERT INTO "Purchase" (shortcode,date,"vendorId") SELECT 'PUR-4K7M','2026-01-02',id FROM "Vendor"`,
    );
    await client.query(
      `INSERT INTO "Expense" (shortcode,"purchaseId",name,"costType",trade,cost,date,"lineKind","lineBasis") SELECT 'EXP-4K7M',id,'Synthetic item','materials','other',19.37,'2026-01-02','principal','item_line' FROM "Purchase"`,
    );
    await client.query(
      `INSERT INTO "Image" (shortcode,key,filename,size,"contentType",status,source,"capturedAt","provenanceEvidence") VALUES ('IMG-4K7M','synthetic/preserved.jpg','preserved.jpg',32,'image/jpeg','UPLOADED','unknown','2026-01-02T12:00:00Z','{"basis":"exif"}')`,
    );
    const before = (await client.query(`SELECT * FROM "Expense" ORDER BY id`))
      .rows;
    const imageBefore = (
      await client.query(
        `SELECT to_jsonb(i) AS data FROM "Image" i ORDER BY id`,
      )
    ).rows;
    await migrateDatabase(drizzle(client));
    expect(
      (await client.query(`SELECT * FROM "Expense" ORDER BY id`)).rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT to_jsonb(i) - 'sourceEvidence' AS data FROM "Image" i ORDER BY id`,
        )
      ).rows,
    ).toEqual(imageBefore);
    await client.query(
      `INSERT INTO "Expense" (shortcode,name,"costType",trade,cost,date,"lineKind","lineBasis") VALUES ('EXP-4K7N','Synthetic unresolved refund','materials','other',-2.13,'2026-01-02','unclassified','item_line')`,
    );
    expect(
      (
        await client.query(
          `SELECT sum(round(cost::numeric * 100))::text AS total FROM "Expense"`,
        )
      ).rows,
    ).toEqual([{ total: "1724" }]);
    expect(
      (
        await client.query(
          `SELECT "purchaseId","productId","projectId","lineKind" FROM "Expense" WHERE shortcode = 'EXP-4K7N'`,
        )
      ).rows,
    ).toEqual([
      {
        purchaseId: null,
        productId: null,
        projectId: null,
        lineKind: "unclassified",
      },
    ]);
  } finally {
    await client.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 60_000);
