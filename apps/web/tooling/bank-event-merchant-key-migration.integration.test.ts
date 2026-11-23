import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("requeues only bank events with potentially changed manual merchant keys", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261123224330_run_operation_completed_target_index",
    });
    const prefix = "index:manualTransaction.merchant:";
    const deps = [
      ["bankEvent", "ascii", prefix + "synthetic market"],
      ["bankEvent", "case", prefix + "Synthetic Market"],
      ["bankEvent", "spaces", prefix + "synthetic  market"],
      ["bankEvent", "spaces", prefix + "synthetic   market"],
      ["bankEvent", "tab", prefix + "synthetic\tmarket"],
      ["bankEvent", "unicode", prefix + "synthetic\u00a0market"],
      ["bankEvent", "other-index", "index:vendor.name:synthetic  market"],
      ["purchaseEvent", "other-kind", prefix + "synthetic  market"],
    ];
    for (const dep of deps)
      await client.query(
        'INSERT INTO "ScopeDep" ("scopeKind", "scopeKey", key) VALUES ($1, $2, $3)',
        dep,
      );
    await client.query(
      `INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, reason, seq, attempts,
        "availableAt", "claimToken", "claimDeadline", "claimedSeq")
      VALUES ('bankEvent', 'spaces', 'money', 'synthetic claim', 2, 4, now() + interval '1 hour',
        gen_random_uuid(), now() + interval '1 hour', 2)`,
    );

    await migrateDatabase(db, {
      through: "20261123233627_drop_manual_entry_merchant_index",
    });

    const dirty = await client.query(
      `SELECT "scopeKey", seq, lane, attempts, "availableAt" <= now() AS due,
        "claimToken", "claimDeadline", "claimedSeq"
      FROM "ScopeDirty" WHERE "scopeKey" = ANY($1) ORDER BY "scopeKey"`,
      [deps.map(([, scopeKey]) => scopeKey)],
    );
    expect(dirty.rows).toEqual(
      ["case", "spaces", "tab", "unicode"].map((scopeKey) => ({
        scopeKey,
        seq: scopeKey === "spaces" ? "3" : "1",
        lane: "money",
        attempts: 0,
        due: true,
        claimToken: null,
        claimDeadline: null,
        claimedSeq: null,
      })),
    );
    const preserved = await client.query(
      'SELECT count(*)::int AS count FROM "ScopeDep" WHERE "scopeKey" = ANY($1)',
      [deps.map(([, scopeKey]) => scopeKey)],
    );
    expect(preserved.rows).toEqual([{ count: deps.length }]);
    const index = await client.query(
      `SELECT to_regclass('"ManualEntry_financial_merchant_idx"') AS name`,
    );
    expect(index.rows).toEqual([{ name: null }]);
  });
});
