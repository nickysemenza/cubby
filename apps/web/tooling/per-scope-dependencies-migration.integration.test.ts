import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("stores new read-index memberships and resets only payment, transfer-pair and Shipment dependencies", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261122173824_kernel_keys_and_email_state",
    });
    for (const [n, kind, code] of [
      [1, "financialAccount", "FAC-SYNTH1"],
      [2, "financialTransaction", "FTX-SYNTH1"],
    ] as const)
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,$2,$3)`,
        [id(n), kind, code],
      );
    await client.query(
      `INSERT INTO "FinancialAccount" (id,shortcode,name,identity) VALUES ($1,'FAC-SYNTH1','Synthetic card','{"kind":"cash"}')`,
      [id(1)],
    );
    await client.query(
      `INSERT INTO "FinancialTransaction" (id,shortcode,"accountId",kind,status,"postedDate","amountMinor") VALUES ($1,'FTX-SYNTH1',$2,'purchase','posted','2026-01-01',1250)`,
      [id(2), id(1)],
    );
    const deps = [
      [
        "purchaseEvent",
        "payment:amount:USD:1250",
        "column:FinancialTransaction:amount",
      ],
      [
        "purchaseEvent",
        "payment:amount:USD:1250",
        "binding:fact:orderObservation:synthetic",
      ],
      [
        "purchaseEvent",
        "synthetic-bank-event",
        "row:FinancialTransaction:synthetic",
      ],
      ["transferPair", "synthetic-pair", "column:FinancialTransaction:amount"],
      ["emailState", "synthetic-email", "row:Email:synthetic"],
    ] as const;
    for (const [kind, key, dep] of deps)
      await client.query(
        `INSERT INTO "ScopeDep" ("scopeKind","scopeKey",key) VALUES ($1,$2,$3)`,
        [kind, key, dep],
      );
    await client.query(
      `INSERT INTO "ScopeDirty" ("scopeKind","scopeKey",lane,reason,seq,attempts,"availableAt")
       VALUES ('purchaseEvent','payment:amount:USD:1250','money','synthetic',2,4,now() + interval '1 hour')`,
    );

    await migrateDatabase(db, {
      through: "20261123133844_per_scope_dependencies",
    });

    // Migrations seed their own rows; every assertion reads the synthetic ones.
    const scopeKeys = [...new Set(deps.map(([, key]) => key))];
    const memberships = await client.query<{ key: string; factId: string }>(
      `SELECT key, "factId" FROM "FactKey"
       WHERE "factId" = $1 AND (key LIKE 'index:transaction.amount:%'
         OR key LIKE 'index:transaction.transfer:%') ORDER BY key`,
      [id(2)],
    );
    expect(memberships.rows).toEqual([
      { key: "index:transaction.amount:1250", factId: id(2) },
    ]);
    const kept = await client.query<{ scopeKind: string; scopeKey: string }>(
      `SELECT "scopeKind", "scopeKey" FROM "ScopeDep" WHERE "scopeKey" = ANY($1)
       ORDER BY "scopeKind", "scopeKey"`,
      [scopeKeys],
    );
    expect(kept.rows).toEqual([
      { scopeKind: "emailState", scopeKey: "synthetic-email" },
      { scopeKind: "purchaseEvent", scopeKey: "synthetic-bank-event" },
    ]);
    const dirty = await client.query<{
      scopeKind: string;
      scopeKey: string;
      seq: string;
      attempts: number;
      due: boolean;
    }>(
      `SELECT "scopeKind", "scopeKey", seq, attempts, "availableAt" <= now() AS due
       FROM "ScopeDirty" WHERE "scopeKey" = ANY($1) ORDER BY "scopeKind", "scopeKey"`,
      [scopeKeys],
    );
    expect(dirty.rows).toEqual([
      {
        scopeKind: "purchaseEvent",
        scopeKey: "payment:amount:USD:1250",
        seq: "3",
        attempts: 0,
        due: true,
      },
      {
        scopeKind: "transferPair",
        scopeKey: "synthetic-pair",
        seq: "1",
        attempts: 0,
        due: true,
      },
    ]);
  });
});
