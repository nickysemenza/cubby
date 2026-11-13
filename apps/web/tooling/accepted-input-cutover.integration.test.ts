import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import {
  seedCutoverPredecessor,
  cutoverId,
} from "./accepted-input-cutover.fixtures";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves a fresh predecessor and replays only its receipt", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await migrateDatabase(db);
    const before = (
      await client.query(`SELECT count(*)::int n FROM "RecordKey"`)
    ).rows;
    await migrateDatabase(db);
    expect(
      (await client.query(`SELECT count(*)::int n FROM "RecordKey"`)).rows,
    ).toEqual(before);
  });
});

it("carries held values, paid results, redirects and every accepted money row", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await seedCutoverPredecessor(client);
    const before = (
      await client.query(
        `SELECT jsonb_agg(to_jsonb(t) ORDER BY id) value FROM "FinancialTransaction" t`,
      )
    ).rows[0].value;
    await migrateDatabase(db);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(to_jsonb(t) ORDER BY id) value FROM "FinancialTransaction" t`,
        )
      ).rows[0].value,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT state FROM "Ask" WHERE id IN ($1,$2,$3) ORDER BY id`,
          [cutoverId(40), cutoverId(41), cutoverId(42)],
        )
      ).rows.map((r) => r.state),
    ).toEqual(["answered", "unknown", "queued"]);
    expect(
      (
        await client.query(
          `SELECT receipt,sequence FROM "AskScope" WHERE "askId"=$1 AND "scopeKind"='run'`,
          [cutoverId(40)],
        )
      ).rows,
    ).toEqual([{ receipt: { retained: "requester" }, sequence: 7 }]);
    const held = (
      await client.query(
        `SELECT field,kind,"actorKind","actorId" FROM "Decision" WHERE subject=$1 AND id::text LIKE 'ffffffff%' ORDER BY field`,
        [`product:${cutoverId(13)}`],
      )
    ).rows;
    expect(held).toEqual([
      {
        field: "brandId",
        kind: "none",
        actorKind: "member",
        actorId: "synthetic-cutover",
      },
      {
        field: "growsPlantId",
        kind: "none",
        actorKind: "system",
        actorId: null,
      },
      {
        field: "ingredientId",
        kind: "none",
        actorKind: "system",
        actorId: null,
      },
    ]);
    expect(
      (
        await client.query(`SELECT output FROM "Answer" WHERE "inputHash"=$1`, [
          `legacy:field:product:${cutoverId(13)}:categoryId`,
        ])
      ).rows[0].output.value,
    ).toBeNull();
    expect(
      (
        await client.query(
          `SELECT "entityId","mergedAt" IS NOT NULL merged FROM "RecordKey" WHERE entity='purchase' AND "naturalKey"=$1`,
          [`legacy:${cutoverId(6)}`],
        )
      ).rows,
    ).toEqual([{ entityId: cutoverId(4), merged: true }]);
    expect(
      (
        await client.query(
          `SELECT "rejectedAt" IS NOT NULL rejected FROM "RecordKey" WHERE entity='expense' AND "naturalKey"=$1`,
          [`legacy:${cutoverId(9)}`],
        )
      ).rows[0].rejected,
    ).toBe(true);
    expect(
      (
        await client.query(
          `SELECT count(*)::int n FROM "RecordKey" WHERE entity='FinancialTransactionAllocation' AND "scopeKey"=$1`,
          [cutoverId(3)],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await client.query(
          `SELECT to_regclass('public."AiEvaluation"') a,to_regclass('public."AiEvaluationRequest"') r`,
        )
      ).rows,
    ).toEqual([{ a: null, r: null }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int n FROM archive."AiEvaluation_preimage"`,
        )
      ).rows[0].n,
    ).toBe(3);
  });
});

it("aborts atomically for every preservation verification", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await seedCutoverPredecessor(client);
    await migrateDatabase(db, {
      through: "20261113120000_statement_money_evidence",
    });
    const { acceptedInputCutoverSql } =
      await import("./accepted-input-cutover-select");
    const statements = acceptedInputCutoverSql().split(
      "--> statement-breakpoint",
    );
    const corrupt = {
      "money row": "UPDATE cutover_money SET amount=amount+1",
      "money totals": "UPDATE cutover_money SET amount=amount+1",
      recordKey: 'DELETE FROM "RecordKey"',
      manualEntry: 'DELETE FROM "ManualEntry"',
      binding: 'DELETE FROM "EvidenceBinding"',
      scope: 'DELETE FROM "ScopeState"',
      decision: 'DELETE FROM "Decision"',
      ask: 'DELETE FROM "Ask"',
      answer: 'DELETE FROM "Answer"',
      askScope: 'DELETE FROM "AskScope"',
      "audit preimage": 'DELETE FROM archive."AuditLog_authority_preimage"',
      "evaluation preimage": 'DELETE FROM archive."AiEvaluation_preimage"',
      "requester preimage":
        'DELETE FROM archive."AiEvaluationRequest_preimage"',
    };
    let checked = 0;
    for (const [index, statement] of statements.entries()) {
      for (const match of statement.matchAll(
        /IF EXISTS\s*\(([\s\S]*?)\) THEN RAISE EXCEPTION 'Accepted-input cutover: ([^']+) preservation mismatch'; END IF;/g,
      )) {
        const label = match[2]!;
        const sabotage = Object.entries(corrupt).find(
          ([key]) => key === label,
        )?.[1];
        expect(sabotage).toBeDefined();
        await client.query("BEGIN");
        try {
          for (const prefix of statements.slice(0, index))
            await client.query(prefix);
          await client.query(sabotage!);
          await expect(
            client.query(
              `DO $test$ BEGIN IF EXISTS (${match[1]}) THEN RAISE EXCEPTION 'Accepted-input cutover: ${label} preservation mismatch'; END IF; END $test$;`,
            ),
          ).rejects.toThrow(`${label} preservation mismatch`);
        } finally {
          await client.query("ROLLBACK");
        }
        expect(
          (await client.query(`SELECT count(*)::int n FROM "AiEvaluation"`))
            .rows[0].n,
        ).toBe(3);
        checked++;
      }
    }
    expect(checked).toBe(13);
  });
});

it("runs the registered scopes without changing accepted money and proposes the planted disagreement", async () => {
  await withMigrationDatabase(async (client, databaseUrl) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await seedCutoverPredecessor(client);
    await migrateDatabase(db);
    const { relationalSchema } = await import("../src/server/db/schema");
    const { createDatabase } =
      await import("../src/server/db/database-runtime");
    const { createKernel, resolveForRead } =
      await import("../src/server/kernel/api");
    const { KERNEL_MODULES } = await import("../src/server/kernel/modules");
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const query = drizzle({
      client: pool,
      relations: relationalSchema,
      paramsInErrors: true,
    });
    const database = createDatabase(() => ({
      client: query,
      withConnection: async (fn) => {
        const connection = await pool.connect();
        try {
          return await fn(
            drizzle({
              client: connection,
              relations: relationalSchema,
              paramsInErrors: true,
            }),
          );
        } finally {
          connection.release();
        }
      },
    }));
    try {
      const kernel = createKernel(KERNEL_MODULES);
      const money = `SELECT jsonb_agg(payload ORDER BY name,id) value FROM (
      SELECT 'transaction' name,id,to_jsonb(t) payload FROM "FinancialTransaction" t
      UNION ALL SELECT 'purchase',id,to_jsonb(t) FROM "Purchase" t
      UNION ALL SELECT 'expense',id,to_jsonb(t) FROM "Expense" t
      UNION ALL SELECT 'allocation',id,to_jsonb(t) FROM "FinancialTransactionAllocation" t
      UNION ALL SELECT 'attribution',id,to_jsonb(t) FROM "ExpenseAttribution" t
      UNION ALL SELECT 'transfer',id,to_jsonb(t) FROM "LedgerTransfer" t) money`;
      const before = (await client.query(money)).rows[0].value;
      const scopes = (
        await client.query<{ kind: string; key: string }>(
          `SELECT "scopeKind" kind,"scopeKey" key FROM "ScopeState" ORDER BY 1,2`,
        )
      ).rows.filter((s) => kernel.registry.reconcilers.has(s.kind));
      const outcomes = await kernel.reconcileNow(database, scopes);
      expect(outcomes).toHaveLength(scopes.length);
      expect(outcomes.filter((o) => o.status === "failed")).toEqual([]);
      expect((await client.query(money)).rows[0].value).toEqual(before);
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM "Drift" WHERE "scopeKind"='purchaseEvent' AND "scopeKey"=$1`,
            [cutoverId(3)],
          )
        ).rows[0].n,
      ).toBe(1);
      const oldCode = (
        await client.query(`SELECT shortcode FROM "Entity" WHERE id=$1`, [
          cutoverId(6),
        ])
      ).rows[0].shortcode;
      expect(await resolveForRead(database, oldCode)).toMatchObject({
        id: cutoverId(4),
        entity: "purchase",
        absorbed: oldCode,
      });
    } finally {
      await pool.end();
    }
  });
});

it("inspects only aggregate projections under PostgreSQL read-only enforcement", async () => {
  await withMigrationDatabase(async (client, databaseUrl) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await seedCutoverPredecessor(client);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fileURLToPath } = await import("node:url");
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./inspect-accepted-input-cutover.ts", import.meta.url),
        ),
        databaseUrl,
      ],
      {
        env: {
          ...process.env,
          PGOPTIONS: "-c default_transaction_read_only=on",
        },
      },
    );
    const { z } = await import("zod");
    const aggregates = z
      .array(
        z.object({
          category: z.string(),
          mapping: z.string(),
          rows: z.number(),
        }),
      )
      .parse(JSON.parse(result.stdout));
    expect(
      aggregates.filter((r) => r.category === "verification" && r.rows !== 0),
    ).toEqual([]);
    expect(
      aggregates.find(
        (r) => r.category === "authority" && r.mapping === "Cubby-held",
      )?.rows,
    ).toBe(1);
    expect(result.stdout).not.toContain(cutoverId(13));
    expect(result.stdout).not.toContain("cutover@example.invalid");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      new URL(
        "../../../artifacts/cutover-synthetic-aggregates.json",
        import.meta.url,
      ),
      result.stdout,
    );
    expect(
      (await client.query(`SELECT count(*)::int n FROM "Ask"`)).rows[0].n,
    ).toBe(0);
  });
});
