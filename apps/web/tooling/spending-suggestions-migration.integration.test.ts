import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Assignment policy changes must preserve a member's switch and immutable applications;
// predecessor writes must remain valid during the deployment overlap.
it("carries assignment settings forward without rewriting historical receipts", async () => {
  await withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), { through: "0100_research_notes" });
    await client.query(`UPDATE "AutomaticRule" SET enabled=true,"enabledReason"='Synthetic member choice'
      WHERE "ruleKey"='field.addition'`);
    await client.query(`INSERT INTO "Assessment" ("publicationKey",family,subject,judgment)
      VALUES ('synthetic-assignment-history','field','{}','{}')`);
    await client.query(`INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority,receipt)
      SELECT id,'synthetic-automatic-operation','ungraded','{}','apply','automatic',
        '{"reason":"confident_addition","automaticRule":"field.addition@2026-10-18.1"}'::jsonb
      FROM "Assessment" WHERE "publicationKey"='synthetic-assignment-history'`);
    const history = (await client.query(`SELECT * FROM "Feedback" ORDER BY id`))
      .rows;
    const before = (
      await client.query(
        `SELECT * FROM "AutomaticRule" WHERE "ruleKey"='field.addition'`,
      )
    ).rows[0];
    await migrateDatabase(drizzle(client));
    const after = (
      await client.query(
        `SELECT * FROM "AutomaticRule" WHERE "ruleKey"='field.addition'`,
      )
    ).rows[0];
    expect(after).toEqual({
      ...before,
      ruleKey: "field.addition",
      revision: "2026-10-20.1",
    });
    expect(
      (await client.query(`SELECT * FROM "Feedback" ORDER BY id`)).rows,
    ).toEqual(history);
    await client.query(`INSERT INTO "AutomaticRule" (family,"ruleKey",revision,enabled)
      VALUES ('field','field.addition','2026-10-18.1',false)
      ON CONFLICT (family,"ruleKey") DO UPDATE SET enabled=false,revision=excluded.revision`);
    expect(
      (
        await client.query(
          `SELECT enabled FROM "AutomaticRule" WHERE "ruleKey"='field.addition'`,
        )
      ).rows,
    ).toEqual([{ enabled: false }]);
  });
});
