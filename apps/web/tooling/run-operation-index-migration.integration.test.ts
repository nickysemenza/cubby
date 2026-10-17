import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Extending the index must retain replay receipts and their identity:
// multiple completed operations per Run are valid, duplicate operation keys are not.
it("preserves operation receipts and replay uniqueness across the audit index migration", async () => {
  return withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), { through: "0079_run_live_state" });
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-operation-index','Synthetic member','operation@example.invalid')`);
    await client.query(`INSERT INTO "Run"
      (shortcode,"actorName","actorUserId","actorEmail",purpose,trigger,status,input)
      VALUES ('RUN-4K7M','Synthetic member','synthetic-operation-index',
        'operation@example.invalid','ai_refresh','manual','completed','{}')`);
    await client.query(`INSERT INTO "RunOperation"
      ("runId","operationId",kind,"inputFingerprint",state,result)
      SELECT r.id,v.operation,v.kind,'synthetic-input',v.state,v.result::jsonb
      FROM "Run" r CROSS JOIN (VALUES
        ('synthetic-a','synthetic-step','completed','{"synthetic":"first receipt"}'),
        ('synthetic-b','synthetic-step','completed','{"synthetic":"second receipt"}'),
        ('synthetic-c','synthetic-step','started',NULL)
      ) AS v(operation,kind,state,result) WHERE r.shortcode='RUN-4K7M'`);
    const receipts = async () =>
      (
        await client.query(
          `SELECT * FROM "RunOperation" ORDER BY "operationId"`,
        )
      ).rows;
    const before = await receipts();

    await migrateDatabase(drizzle(client));

    expect(await receipts()).toEqual(before);
    await client.query(`UPDATE "RunOperation" SET state='completed',result='{"synthetic":"finished"}'
      WHERE "operationId"='synthetic-c'`);
    expect(
      (
        await client.query(
          `SELECT "operationId" FROM "RunOperation"
        WHERE "runId"=$1 AND state='completed' ORDER BY "operationId"`,
          [before[0].runId],
        )
      ).rows,
    ).toEqual([
      { operationId: "synthetic-a" },
      { operationId: "synthetic-b" },
      { operationId: "synthetic-c" },
    ]);
    await expect(
      client.query(
        `INSERT INTO "RunOperation" ("runId","operationId",kind,"inputFingerprint")
        VALUES ($1,'synthetic-a','synthetic-step','synthetic-input')`,
        [before[0].runId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
