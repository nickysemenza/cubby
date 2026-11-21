import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("reopens adoption scopes parked as unregistered and keeps every other parked scope", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261121140353_merge_finance_index_snapshots",
    });
    const rows = [
      ["emailState", "Unregistered reconciler: emailState"],
      ["transferPair", "Unregistered reconciler: transferPair"],
      ["emailState", "synthetic target failure"],
      ["synthetic.removed", "Unregistered reconciler: synthetic.removed"],
    ] as const;
    for (const [index, [kind, error]] of rows.entries())
      await client.query(
        `INSERT INTO "ScopeDirty" ("scopeKind","scopeKey",lane,reason,seq,attempts,"lastError","availableAt")
         VALUES ($1,$2,'money','order evidence adoption',3,5,$3,now() + interval '1 hour')`,
        [kind, `synthetic-${index}`, error],
      );
    await migrateDatabase(db, {
      through: "20261121150842_reopen_unregistered_scope_work",
    });
    const after = await client.query<{
      scopeKey: string;
      seq: string;
      attempts: number;
      lastError: string | null;
      due: boolean;
    }>(
      `SELECT "scopeKey", seq, attempts, "lastError", "availableAt" <= now() AS due
       FROM "ScopeDirty" ORDER BY "scopeKey"`,
    );
    expect(after.rows).toEqual([
      {
        scopeKey: "synthetic-0",
        seq: "3",
        attempts: 0,
        lastError: null,
        due: true,
      },
      {
        scopeKey: "synthetic-1",
        seq: "3",
        attempts: 0,
        lastError: null,
        due: true,
      },
      {
        scopeKey: "synthetic-2",
        seq: "3",
        attempts: 5,
        lastError: "synthetic target failure",
        due: false,
      },
      {
        scopeKey: "synthetic-3",
        seq: "3",
        attempts: 5,
        lastError: "Unregistered reconciler: synthetic.removed",
        due: false,
      },
    ]);
  });
});
