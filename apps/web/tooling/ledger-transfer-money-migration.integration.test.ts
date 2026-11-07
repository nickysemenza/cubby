import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// A transfer's parties and attached evidence must retain the same owner when
// the authoritative amount changes units; its archived predecessor is inert.
it("preserves transfer parties, claims and original evidence through minor-unit storage", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client: client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261105170357_0096_source_claim_minor_units",
    });
    const ids = [
      "00000000-0000-4000-8000-000000000101",
      "00000000-0000-4000-8000-000000000102",
    ];
    for (const [index, id] of ids.entries()) {
      const code = `LPY-SYNMONEY${index}`;
      await client.query(
        `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'ledgerParty', $2)`,
        [id, code],
      );
      await client.query(
        `INSERT INTO "LedgerParty" (id, shortcode, name, kind) VALUES ($1, $2, 'Synthetic party', 'guest')`,
        [id, code],
      );
    }
    const transfer = "00000000-0000-4000-8000-000000000201";
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'ledgerTransfer', 'LTR-SYNMONEY')`,
      [transfer],
    );
    await client.query(
      `INSERT INTO "LedgerTransfer" (id, shortcode, "fromPartyId", "toPartyId", amount, date, notes, "deletedAt") VALUES ($1, 'LTR-SYNMONEY', $2, $3, 10.01, '2026-01-01', 'Retained reviewed movement', '2026-01-02')`,
      [transfer, ...ids],
    );
    await client.query(
      `INSERT INTO "ExternalSource" (slug, label) VALUES ('synthetic-money', 'Synthetic money')`,
    );
    await client.query(
      `INSERT INTO "LedgerSourceClaim" ("ledgerTransferId", source, "sourceKey", "sourceKeyVersion", "normalizedEvidence", "targetAmountMinor", "reconciliationDecision") VALUES ($1, 'synthetic-money', 'retained-transfer-proof', 1, '{"amount":10.01}', 1001, 'amounts_match')`,
      [transfer],
    );
    const before = await client.query(
      `SELECT to_jsonb(t) AS value FROM "LedgerTransfer" t`,
    );
    const claims = await client.query(
      `SELECT to_jsonb(c) AS value FROM "LedgerSourceClaim" c`,
    );
    const cancelledRun = "00000000-0000-4000-8000-000000000301";
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('transfer-migration','Synthetic member','transfer@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run','RUN-SYNTRANSFER')`,
      [cancelledRun],
    );
    await client.query(
      `INSERT INTO "Run" (id,shortcode,"actorName",trigger,purpose,"actorUserId","actorEmail",status,"failureCode","endedAt") VALUES ($1,'RUN-SYNTRANSFER','Synthetic member','manual','sweep','transfer-migration','transfer@example.test','failed','user_cancelled',now())`,
      [cancelledRun],
    );
    await client.query(
      `INSERT INTO "RunStep" ("runId",key,label,position,state) VALUES ($1,'statement_generate','Synthetic retained scan',0,'running')`,
      [cancelledRun],
    );
    await client.query(
      `INSERT INTO "Job" (key,kind,state,"runId",input) VALUES ('synthetic-transfer-cancel','run.execute','queued',$1,'{}')`,
      [cancelledRun],
    );
    await expect(
      migrateDatabase(db, {
        through: "20261105170357_0097_ledger_transfer_minor_units",
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "P0001",
        message:
          "Financial refresh has unfinished steps; complete or explicitly cancel its retained work before the money cutover",
      },
    });
    await client.query(
      `UPDATE "Job" SET state='cancelled' WHERE key='synthetic-transfer-cancel'`,
    );
    await client.query(`UPDATE "LedgerTransfer" SET amount=10.010000000000002`);
    await expect(
      migrateDatabase(db, {
        through: "20261105170357_0097_ledger_transfer_minor_units",
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "P0001",
        message:
          "Transfer money failed independent IEEE round-trip preservation",
      },
    });
    expect(
      (
        await client.query(
          `SELECT to_regclass('archive."LedgerTransfer_dollar_preimage"') AS archived`,
        )
      ).rows,
    ).toEqual([{ archived: null }]);
    await client.query(`UPDATE "LedgerTransfer" SET amount=10.01`);
    await migrateDatabase(db, {
      through: "20261105170357_0097_ledger_transfer_minor_units",
    });
    expect(
      (
        await client.query(
          `SELECT (to_jsonb(t) - 'amountMinor') || jsonb_build_object('amount', t."amountMinor"::numeric / 100) AS value FROM "LedgerTransfer" t`,
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await client.query(
          `SELECT to_jsonb(t) AS value FROM archive."LedgerTransfer_dollar_preimage" t`,
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await client.query(
          `SELECT to_jsonb(c) AS value FROM "LedgerSourceClaim" c`,
        )
      ).rows,
    ).toEqual(claims.rows);
    expect(
      (
        await client.query(
          `SELECT "amountMinor"::text AS minor FROM "LedgerTransfer"`,
        )
      ).rows,
    ).toEqual([{ minor: "1001" }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS attached FROM "LedgerSourceClaim" c JOIN "LedgerTransfer" t ON t.id=c."ledgerTransferId"`,
        )
      ).rows,
    ).toEqual([{ attached: 1 }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS active FROM pg_constraint WHERE contype='f' AND (conrelid='archive."LedgerTransfer_dollar_preimage"'::regclass OR confrelid='archive."LedgerTransfer_dollar_preimage"'::regclass)`,
        )
      ).rows,
    ).toEqual([{ active: 0 }]);
    await expect(
      client.query(`UPDATE "LedgerTransfer" SET "amountMinor"=0`),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(`UPDATE "LedgerTransfer" SET amount=10`),
    ).rejects.toMatchObject({ code: "42703" });
  });
});
