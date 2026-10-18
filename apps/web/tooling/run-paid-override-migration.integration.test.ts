import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// The widened action constraint must retain old control history and admit only
// positive, explicit paid allowances on the new action.
it("preserves Run control history while admitting explicit paid overrides", async () => {
  await withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), {
      through: "0089_ai_usage_failure",
    });
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-paid-migration','Example Member','member@example.invalid')`);
    await client.query(`INSERT INTO "Run"
      (shortcode,"actorName","actorUserId","actorEmail",purpose,trigger,status,input)
      VALUES ('RUN-4K7M','Example Member','synthetic-paid-migration','member@example.invalid','mail_import','discovery','paused_auth','{}')`);
    await client.query(`INSERT INTO "RunControlEvent"
      ("runId",action,"controllerUserId","controllerName","controllerEmail",
       "controllerLedgerPartyId","controllerLedgerPartyShortcode","controllerLedgerPartyName","controllerLedgerPartyKind")
      SELECT id,'pause','synthetic-paid-migration','Example Member','member@example.invalid',
        gen_random_uuid(),'LPY-4K7M','Example Member','member' FROM "Run"`);
    const before = (await client.query(`SELECT * FROM "RunControlEvent"`)).rows;
    const runs = (await client.query(`SELECT * FROM "Run"`)).rows;
    await migrateDatabase(drizzle(client), {
      through: "0090_run_paid_override",
    });
    expect((await client.query(`SELECT * FROM "Run"`)).rows).toEqual(runs);
    expect(
      (await client.query(`SELECT * FROM "RunControlEvent"`)).rows,
    ).toEqual(before.map((row) => ({ ...row, paidOverBudgetUsd: null })));
    const grant = (action: string, amount: number | null) =>
      client.query(
        `INSERT INTO "RunControlEvent"
          ("runId",action,"controllerUserId","controllerName","controllerEmail",
           "controllerLedgerPartyId","controllerLedgerPartyShortcode","controllerLedgerPartyName","controllerLedgerPartyKind","paidOverBudgetUsd")
          SELECT "runId",$1,"controllerUserId","controllerName","controllerEmail",
            "controllerLedgerPartyId","controllerLedgerPartyShortcode","controllerLedgerPartyName","controllerLedgerPartyKind",$2
          FROM "RunControlEvent" WHERE action='pause'`,
        [action, amount],
      );
    await grant("run_now_paid", null);
    await grant("run_now_paid", 2);
    await expect(grant("run_now_paid", 0)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(grant("run_now_paid", -1)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(grant("resume", 2)).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await client.query(
          `SELECT "paidOverBudgetUsd" FROM "RunControlEvent" WHERE action='run_now_paid' ORDER BY "paidOverBudgetUsd" NULLS FIRST`,
        )
      ).rows,
    ).toEqual([{ paidOverBudgetUsd: null }, { paidOverBudgetUsd: 2 }]);
  });
});
