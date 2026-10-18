import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// The deployed writer keeps inserting without `failure` while the release
// applies this migration; existing usage rows must survive unchanged.
it("adds AiUsage failure without changing usage rows or the deployed writer", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const expand = tags.findIndex((tag) => tag.endsWith("_ai_usage_failure"));
    if (expand < 1)
      throw new Error("AiUsage failure migration has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[expand - 1]! });
    await client.query(`INSERT INTO "user" (id, name, email)
      VALUES ('synthetic-usage-member', 'Synthetic member', 'usage-member@example.invalid')`);
    await client.query(`INSERT INTO "LedgerParty" (shortcode, name, kind, "userId")
      VALUES ('LPY-4K7M', 'Synthetic member', 'member', 'synthetic-usage-member')`);
    await client.query(`INSERT INTO "Run" (shortcode, trigger, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "ledgerPartyId")
      SELECT 'RUN-4K7M', 'manual', 'synthetic-usage-member', 'Synthetic member', 'usage-member@example.invalid', 'LPY-4K7M', p.id FROM "LedgerParty" p`);
    const insertUsage = (status: string) =>
      client.query(`INSERT INTO "AiUsage" (feature, provider, model, operation, "runId", status, "durationMs", transport)
        SELECT 'synthetic-feature', 'openai', 'gpt-6-sol', 'synthetic.operation', r.id, '${status}', 1500, 'chatgpt' FROM "Run" r`);
    await insertUsage("failed");
    const rows = async () =>
      (
        await client.query(
          `SELECT to_jsonb(u) - 'failure' AS data FROM "AiUsage" u ORDER BY "createdAt", id`,
        )
      ).rows;
    const before = await rows();
    expect(before).toHaveLength(1);
    await migrateDatabase(drizzle(client), { through: tags[expand]! });
    expect((await rows()).slice(0, 1)).toEqual(before);
    await insertUsage("succeeded");
    expect(
      (
        await client.query(
          `SELECT failure FROM "AiUsage" ORDER BY "createdAt", id`,
        )
      ).rows,
    ).toEqual([{ failure: null }, { failure: null }]);
  });
});
