import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Building the history index must preserve inactive suppression/labels and the
// active-only uniqueness contract while predecessor code continues publishing.
it("preserves statement history and active charge uniqueness across indexing", async () => {
  await withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), {
      through: "0102_assignment_policy",
    });
    await client.query(`INSERT INTO "Assessment" ("publicationKey",family,subject,judgment)
      VALUES ('synthetic-charge-retired','statement_transaction','{}','{}'),
        ('synthetic-charge-current','statement_transaction','{}','{}')`);
    await client.query(`INSERT INTO "AssessmentState" (id,entity,"recordId",family,active,status,data,suppression)
      SELECT id,'statementRow','11111111-1111-4111-8111-111111111111',family,
        "publicationKey"='synthetic-charge-current','rejected',
        '{"source":"monarch","chargeKey":"synthetic-charge","needsLabel":false,"label":"Synthetic retained label"}'::jsonb,
        '{"reason":"Synthetic member dismissal"}'::jsonb
      FROM "Assessment" WHERE "publicationKey" IN ('synthetic-charge-retired','synthetic-charge-current')`);
    const history = async () =>
      (
        await client.query(`SELECT to_jsonb(a) AS assessment,to_jsonb(s) AS state
          FROM "Assessment" a JOIN "AssessmentState" s ON s.id=a.id
          WHERE s.family='statement_transaction' AND s.data->>'source'='monarch'
            AND s.data->>'chargeKey'='synthetic-charge'
          ORDER BY s."createdAt" DESC,s.id DESC`)
      ).rows;
    const before = await history();
    expect(before).toHaveLength(2);
    await migrateDatabase(drizzle(client), {
      through: "0103_statement_charge_history",
    });
    expect(await history()).toEqual(before);

    await client.query(`INSERT INTO "Assessment" ("publicationKey",family,subject,judgment)
      VALUES ('synthetic-charge-next','statement_transaction','{}','{}')`);
    const publish = () =>
      client.query(`INSERT INTO "AssessmentState" (id,entity,"recordId",family,data)
        SELECT id,'statementRow','11111111-1111-4111-8111-111111111111',family,
          '{"source":"monarch","chargeKey":"synthetic-charge"}'::jsonb
        FROM "Assessment" WHERE "publicationKey"='synthetic-charge-next'`);
    await expect(publish()).rejects.toMatchObject({
      code: "23505",
      constraint: "AssessmentState_statement_charge_key",
    });
    await client.query(`UPDATE "AssessmentState" SET active=false
      WHERE family='statement_transaction' AND data->>'source'='monarch'
        AND data->>'chargeKey'='synthetic-charge'`);
    await publish();
    expect(await history()).toHaveLength(3);
    expect(
      (
        await client.query(`SELECT count(*)::int AS count FROM "AssessmentState"
          WHERE family='statement_transaction' AND data->>'source'='monarch'
            AND data->>'chargeKey'='synthetic-charge' AND active`)
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
});
