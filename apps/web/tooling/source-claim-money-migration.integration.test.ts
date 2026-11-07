import { moneyToMinor, minorToMoney } from "@cubby/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Guard reviewed mismatches, tombstones, retained source keys and dependent FKs
// while moving an authoritative monetary amount from dollars to integer cents.
it("preserves source claims and their dollar-number wire through the minor-unit cutover", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client: client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261105170357_0095_stop_diagnostic_ticket_admission",
    });
    const expense = "00000000-0000-4000-8000-000000000101";
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'expense', 'EXP-SYNMONEY')`,
      [expense],
    );
    await client.query(
      `INSERT INTO "Expense" (id, shortcode, name, "costType", cost, date) VALUES ($1, 'EXP-SYNMONEY', 'Synthetic cost', 'materials', 10.01, '2026-01-01')`,
      [expense],
    );
    await client.query(
      `INSERT INTO "ExternalSource" (slug, label) VALUES ('synthetic-money', 'Synthetic money')`,
    );
    for (const [index, amount] of [10.01, -10.02].entries()) {
      await client.query(
        `INSERT INTO "LedgerSourceClaim" (id, "expenseId", source, "sourceKey", "sourceKeyVersion", "normalizedEvidence", "targetAmountAtClaim", "reconciliationDecision", "reconciliationNote", "deletedAt")
        VALUES ($1, $2, 'synthetic-money', $3, 1, $4, $5, $6, $7, $8)`,
        [
          `00000000-0000-4000-8000-00000000020${index}`,
          expense,
          `synthetic-key-${index}`,
          JSON.stringify({
            amount: index === 0 ? 10.01 : -10.01,
            occurredOn: null,
            description: "Retained source",
            context: null,
            disambiguator: null,
          }),
          amount,
          index === 0 ? "amounts_match" : "accept_target_amount",
          index === 0 ? null : "Reviewed mismatch",
          index === 0 ? null : "2026-01-02",
        ],
      );
    }
    await client.query(
      `CREATE TABLE "ClaimMoneyConsumer" ("claimId" uuid REFERENCES "LedgerSourceClaim"(id)); INSERT INTO "ClaimMoneyConsumer" SELECT id FROM "LedgerSourceClaim"`,
    );
    const before = await client.query(
      `SELECT to_jsonb(c) AS value FROM "LedgerSourceClaim" c ORDER BY id`,
    );
    const run = "00000000-0000-4000-8000-000000000301";
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('money-migration','Synthetic member','money@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run','RUN-SYNMONEY')`,
      [run],
    );
    await client.query(
      `INSERT INTO "Run" (id,shortcode,"actorName",trigger,purpose,"actorUserId","actorEmail",status)
      VALUES ($1,'RUN-SYNMONEY','Synthetic member','manual','sweep','money-migration','money@example.test','failed')`,
      [run],
    );
    await client.query(
      `INSERT INTO "RunStep" ("runId",key,label,position,state) VALUES ($1,'statement_generate','Synthetic generation',0,'running')`,
      [run],
    );
    await client.query(`UPDATE "Run" SET "endedAt"=now() WHERE id=$1`, [run]);
    await expect(
      migrateDatabase(db, {
        through: "20261105170357_0096_source_claim_minor_units",
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "P0001",
        message:
          "Financial refresh has unfinished steps; complete or explicitly cancel its retained work before the money cutover",
      },
    });
    await client.query(
      `UPDATE "Run" SET "failureCode"='user_cancelled',"endedAt"=now() WHERE id=$1`,
      [run],
    );
    await client.query(
      `INSERT INTO "Job" (key,kind,state,"runId",input) VALUES ('synthetic-financial-gate','run.execute','queued',$1,'{}')`,
      [run],
    );
    for (const state of ["queued", "running", "retry_wait", "paused"]) {
      await client.query(
        `UPDATE "Job" SET state=$1 WHERE key='synthetic-financial-gate'`,
        [state],
      );
      await expect(
        migrateDatabase(db, {
          through: "20261105170357_0096_source_claim_minor_units",
        }),
      ).rejects.toMatchObject({
        cause: {
          code: "P0001",
          message:
            "Financial refresh has unfinished steps; complete or explicitly cancel its retained work before the money cutover",
        },
      });
    }
    await client.query(
      `UPDATE "Job" SET state='cancelled' WHERE key='synthetic-financial-gate'`,
    );
    await client.query(
      `UPDATE "Run" SET "failureCode"='job_failed' WHERE id=$1`,
      [run],
    );
    await expect(
      migrateDatabase(db, {
        through: "20261105170357_0096_source_claim_minor_units",
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "P0001",
        message:
          "Financial refresh has unfinished steps; complete or explicitly cancel its retained work before the money cutover",
      },
    });
    // The cancelled parent and terminal Job permit the original running step; nothing rewrites its cursor or counters.
    await client.query(
      `UPDATE "Run" SET "failureCode"='user_cancelled' WHERE id=$1`,
      [run],
    );
    // The old epsilon permits noise that the new contract must not silently round.
    await client.query(
      `UPDATE "LedgerSourceClaim" SET "targetAmountAtClaim"=10.010000000001 WHERE "sourceKey"='synthetic-key-0'`,
    );
    await expect(
      migrateDatabase(db, {
        through: "20261105170357_0096_source_claim_minor_units",
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "P0001",
        message:
          "Source-claim money is not exactly representable in the supported minor-unit range",
      },
    });
    expect(
      (
        await client.query(
          `SELECT to_regclass('archive."LedgerSourceClaim_dollar_preimage"') AS archived`,
        )
      ).rows,
    ).toEqual([{ archived: null }]);
    await client.query(
      `UPDATE "LedgerSourceClaim" SET "targetAmountAtClaim"=10.01 WHERE "sourceKey"='synthetic-key-0'`,
    );
    await client.query(
      `UPDATE "LedgerSourceClaim" SET "targetAmountAtClaim"=10.010000000000002 WHERE "sourceKey"='synthetic-key-0'`,
    );
    await expect(
      migrateDatabase(db, {
        through: "20261105170357_0096_source_claim_minor_units",
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "P0001",
        message:
          "Source-claim money failed independent IEEE round-trip preservation",
      },
    });
    expect(
      (
        await client.query(
          `SELECT to_regclass('archive."LedgerSourceClaim_dollar_preimage"') AS archived`,
        )
      ).rows,
    ).toEqual([{ archived: null }]);
    await client.query(
      `UPDATE "LedgerSourceClaim" SET "targetAmountAtClaim"=10.01 WHERE "sourceKey"='synthetic-key-0'`,
    );
    await migrateDatabase(db, {
      through: "20261105170357_0096_source_claim_minor_units",
    });
    const after = await client.query(
      `SELECT (to_jsonb(c) - 'targetAmountMinor') || jsonb_build_object('targetAmountAtClaim', c."targetAmountMinor"::numeric / 100) AS value FROM "LedgerSourceClaim" c ORDER BY id`,
    );
    expect(after.rows).toEqual(before.rows);
    expect(
      (
        await client.query(
          `SELECT to_jsonb(c) AS value FROM archive."LedgerSourceClaim_dollar_preimage" c ORDER BY id`,
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await client.query(
          `SELECT "targetAmountMinor"::text AS minor FROM "LedgerSourceClaim" ORDER BY id`,
        )
      ).rows,
    ).toEqual([{ minor: "1001" }, { minor: "-1002" }]);
    expect(
      (
        await client.query(
          `SELECT confrelid::regclass::text AS owner FROM pg_constraint WHERE conrelid='"ClaimMoneyConsumer"'::regclass AND contype='f'`,
        )
      ).rows,
    ).toEqual([{ owner: '"LedgerSourceClaim"' }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS active FROM pg_constraint WHERE contype='f' AND conrelid='archive."LedgerSourceClaim_dollar_preimage"'::regclass`,
        )
      ).rows,
    ).toEqual([{ active: 0 }]);
    await expect(
      client.query(
        `UPDATE "LedgerSourceClaim" SET "targetAmountMinor"=1002 WHERE "sourceKey"='synthetic-key-0'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        `UPDATE "LedgerSourceClaim" SET "normalizedEvidence"='{"amount":null}' WHERE "sourceKey"='synthetic-key-0'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        `UPDATE "LedgerSourceClaim" SET "targetAmountAtClaim"=10 WHERE "sourceKey"='synthetic-key-0'`,
      ),
    ).rejects.toMatchObject({ code: "42703" });
    for (const value of [0, 0.01, -0.01, 10.01, -10.02, 1e12, -1e12]) {
      expect(minorToMoney(moneyToMinor(value))).toBe(value);
    }
    expect(() => moneyToMinor(-1.005)).toThrow("exact whole cent");
    expect(() => moneyToMinor(1.005)).toThrow("exact whole cent");
    expect(() => moneyToMinor(Number.POSITIVE_INFINITY)).toThrow("finite");
    expect(() => minorToMoney(100_000_000_000_001n)).toThrow("wire range");
  });
});
