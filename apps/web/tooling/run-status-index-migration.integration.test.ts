import { withMigrationDatabase } from "./test-database-lease";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";

// Adding the live-state access path must preserve retained history and permit
// multiple Runs in the same state; it is not an execution uniqueness rule.
it("preserves Run history and state transitions across the live-state index migration", async () => {
  return withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), {
      through: "0078_drop_vendor_account_status",
    });
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-run-index','Synthetic member','run@example.invalid')`);
    await client.query(`INSERT INTO "Run"
      (shortcode,"actorName","actorUserId","actorEmail",purpose,trigger,status,"failureCode",input)
      VALUES
      ('RUN-4K7M','Synthetic member','synthetic-run-index','run@example.invalid','ai_suggest','manual','completed',NULL,'{"synthetic":"retained"}'),
      ('RUN-5N8P','Synthetic member','synthetic-run-index','run@example.invalid','ai_refresh','manual','running',NULL,'{}'),
      ('RUN-6Q9R','Synthetic member','synthetic-run-index','run@example.invalid','ai_refresh','manual','running',NULL,'{}'),
      ('RUN-7S2T','Synthetic member','synthetic-run-index','run@example.invalid','ai_refresh','manual','needs_review','vendor_history_prerequisite','{}')`);
    const history = async () =>
      (await client.query(`SELECT * FROM "Run" ORDER BY shortcode`)).rows;
    const before = await history();
    await migrateDatabase(drizzle(client));
    expect(await history()).toEqual(before);
    await client.query(
      `UPDATE "Run" SET status='completed',"failureCode"=NULL WHERE shortcode='RUN-7S2T'`,
    );
    expect(
      (
        await client.query(
          `SELECT status,"failureCode" FROM "Run" WHERE shortcode='RUN-7S2T'`,
        )
      ).rows,
    ).toEqual([{ status: "completed", failureCode: null }]);
  });
});
