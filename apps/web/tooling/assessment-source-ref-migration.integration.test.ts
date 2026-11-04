import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("indexes long retained source references without changing evidence or unfinished work", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0067_foreign_receipt_coverage" });
    const id = "00000000-0000-4000-8000-000000000101";
    const longText = Array.from({ length: 512 }, (_, index) =>
      createHash("sha256")
        .update(`Synthetic retained identity ${index}`)
        .digest("hex"),
    ).join("");
    await client.query(
      `INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,evidence)
       VALUES ($1,'synthetic-long-source','statement_transaction','{}',$2::jsonb,'{"retained":"Synthetic evidence"}')`,
      [
        id,
        JSON.stringify({
          create: { sourceRef: { source: longText, externalId: longText } },
        }),
      ],
    );
    await client.query(
      `INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority)
       VALUES ($1,'synthetic-retained-receipt','ungraded','{"present":false}','history','system')`,
      [id],
    );
    await client.query(
      `INSERT INTO "WorkItem" (target,ref,attempts,"lastError","readyAt")
       VALUES ('synthetic.retained',$1,2,'Synthetic retained retry',now()+interval '1 hour')`,
      [id],
    );
    const retained = async () => ({
      assessments: (
        await client.query(
          `SELECT to_jsonb(a) AS value FROM "Assessment" a ORDER BY id`,
        )
      ).rows,
      feedback: (
        await client.query(
          `SELECT to_jsonb(f) AS value FROM "Feedback" f ORDER BY id`,
        )
      ).rows,
      work: (
        await client.query(
          `SELECT to_jsonb(w) AS value FROM "WorkItem" w ORDER BY target,ref`,
        )
      ).rows,
    });
    const before = await retained();
    await migrateDatabase(db, {
      through: "0068_assessment_settlement_source_index",
    });
    expect(await retained()).toEqual(before);
    expect(
      (
        await client.query(`SELECT i.indisready,i.indisvalid FROM pg_index i
       JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='Assessment_served_source_ref_idx'`)
      ).rows,
    ).toEqual([{ indisready: true, indisvalid: true }]);
    await client.query(
      `INSERT INTO "Assessment" ("publicationKey",family,subject,judgment)
       VALUES ('synthetic-long-source-after','field','{}',$1::jsonb)`,
      [
        JSON.stringify({
          create: {
            sourceRef: { source: `${longText}a`, externalId: `${longText}b` },
          },
        }),
      ],
    );
  });
}, 90000);
