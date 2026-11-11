import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("rebuilds an index an interrupted concurrent build left invalid", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261111055338_single_category_vendor_profile",
    });
    // A failed concurrent build keeps its name as an invalid index.
    await client.query(`CREATE TABLE "SyntheticDuplicate" (x int)`);
    await client.query(`INSERT INTO "SyntheticDuplicate" VALUES (1), (1)`);
    await expect(
      client.query(
        `CREATE UNIQUE INDEX CONCURRENTLY "Run_party_evidenceRevision_idx" ON "SyntheticDuplicate" (x)`,
      ),
    ).rejects.toThrow("could not create unique index");
    await migrateDatabase(db, {
      through: "20261111175923_mail_import_probe_indexes",
    });
    const { rows } = await client.query<{ valid: boolean; table: string }>(
      `SELECT i.indisvalid AS valid, i.indrelid::regclass::text AS table
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'Run_party_evidenceRevision_idx'`,
    );
    expect(rows).toEqual([{ valid: true, table: '"Run"' }]);
  });
});
