import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { testServiceConfig } from "./test-service-config";

// Expansion must retain complete and ambiguous old receipts, member pauses, and household spending.
it("preserves manual Run history and household accounting through durable work expansion", async () => {
  const service = testServiceConfig();
  const adminUrl = `postgresql://postgres:password@${service.host}:${service.port}/postgres`;
  const name = `cubby_durable_ai_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.href });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await client.connect();
    await migrateDatabase(drizzle(client), {
      through: "0056_retire_label_review_metadata",
    });
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('synthetic-durable-member','Synthetic member','durable@example.invalid')`,
    );
    await client.query(
      `INSERT INTO "LedgerParty" (shortcode,name,kind,"userId") VALUES ('LPY-4K7M','Synthetic member','member','synthetic-durable-member')`,
    );
    await client.query(
      `INSERT INTO "Vendor" (shortcode,name) VALUES ('VEN-4K7M','Synthetic vendor')`,
    );
    await client.query(
      `INSERT INTO "Purchase" (shortcode,date,"vendorId") SELECT 'PUR-4K7M','2026-10-09',id FROM "Vendor"`,
    );
    await client.query(
      `INSERT INTO "Expense" (shortcode,"purchaseId",name,"costType",trade,cost,date,"lineKind","lineBasis") SELECT 'EXP-4K7M',id,'Synthetic goods','materials','other',201.57,'2026-10-09','principal','item_line' FROM "Purchase"`,
    );
    await client.query(
      `INSERT INTO "Expense" (shortcode,"purchaseId",name,"costType",trade,cost,date,"lineKind","lineBasis") SELECT 'EXP-4K7N',id,'Synthetic free reward','materials','other',-5,'2026-10-09','discount','item_line' FROM "Purchase"`,
    );
    await client.query(`INSERT INTO "Run" (shortcode,"actorName","actorUserId","actorEmail",purpose,trigger,status,input,progress) VALUES
      ('RUN-4K7M','Synthetic member','synthetic-durable-member','durable@example.invalid','background','manual','completed','{"kind":"mail_reclassify","mode":"relevance","mailboxId":"synthetic-mailbox","emails":[]}', '{"kind":"mail_reclassification","version":1,"complete":true,"results":[]}'),
      ('RUN-4K7N','Synthetic member','synthetic-durable-member','durable@example.invalid','suggestion_sweep','manual','running','{"entity":"product","fields":["categoryId"],"paused":true}', '{"total":2,"done":1,"applied":1,"queued":0,"failed":0}'),
      ('RUN-4K7P','Synthetic member','synthetic-durable-member','durable@example.invalid','background','manual','completed','{"kind":"mail_reclassify","mode":"preview","mailboxId":"synthetic-mailbox","emails":[]}', null)`);
    await client.query(`INSERT INTO "Run" (shortcode,"actorName","actorUserId","actorEmail",purpose,trigger,status,"failureCode",input,progress) VALUES
      ('RUN-4K7Q','Synthetic member','synthetic-durable-member','durable@example.invalid','background','manual','needs_review','execution_limit','{"kind":"mail_reclassify","mode":"relevance","mailboxId":"synthetic-mailbox","emails":[]}', '{"kind":"mail_reclassification","version":1,"complete":false,"results":[]}')`);
    const accounting = async () =>
      (
        await client.query(
          `SELECT to_jsonb(e) AS data FROM "Expense" e ORDER BY id`,
        )
      ).rows;
    const history = async () =>
      (
        await client.query(
          `SELECT shortcode,purpose,status,"failureCode",input,progress FROM "Run" ORDER BY shortcode`,
        )
      ).rows;
    const before = await history();
    const expenses = await accounting();
    await migrateDatabase(drizzle(client));
    expect(await accounting()).toEqual(expenses);
    expect(await history()).toEqual(
      before.map((row) => ({
        ...row,
        purpose: ["RUN-4K7M", "RUN-4K7Q"].includes(row.shortcode)
          ? "mail_reclassify"
          : row.purpose,
        status: row.shortcode === "RUN-4K7N" ? "paused" : row.status,
      })),
    );
    expect(
      (await client.query(`SELECT sum(cost) AS total FROM "Expense"`)).rows[0]
        ?.total,
    ).toBe(196.57);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "AiEvaluationRequest"`,
        )
      ).rows[0]?.count,
    ).toBe(0);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
