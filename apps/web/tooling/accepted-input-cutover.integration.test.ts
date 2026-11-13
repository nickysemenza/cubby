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
    const retained = `SELECT jsonb_agg(payload ORDER BY name,payload::text) value FROM (
      SELECT 'EmailPurchaseDecision' name,to_jsonb(t) payload FROM "EmailPurchaseDecision" t
      UNION ALL SELECT 'EmailReview',to_jsonb(t) FROM "EmailReview" t
      UNION ALL SELECT 'EmailFinancialAssociation',to_jsonb(t) FROM "EmailFinancialAssociation" t
      UNION ALL SELECT 'SourceObservationAnnotation',to_jsonb(t) FROM "SourceObservationAnnotation" t
      UNION ALL SELECT 'Shipment',to_jsonb(t) FROM "Shipment" t
      UNION ALL SELECT 'LedgerTransfer',to_jsonb(t) FROM "LedgerTransfer" t
      UNION ALL SELECT 'Suggestion',to_jsonb(t) FROM "Suggestion" t WHERE family IN ('transfer_pair','product_pair')) retained`;
    const retainedBefore = (await client.query(retained)).rows[0].value;
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
    expect((await client.query(retained)).rows[0].value).toEqual(
      retainedBefore,
    );
    expect(
      (
        await client.query(
          `SELECT count(*)::int n FROM "RecordKey" WHERE entity IN ('ledgerTransfer','shipment')`,
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await client.query(
          `SELECT "scopeKey","entityId" FROM "RecordKey" WHERE "scopeKind"='bankEvent' AND "scopeKey" IN ($1,$2) ORDER BY "scopeKey"`,
          [cutoverId(17), cutoverId(63)],
        )
      ).rows,
    ).toEqual([
      { scopeKey: cutoverId(17), entityId: cutoverId(3) },
      { scopeKey: cutoverId(63), entityId: cutoverId(3) },
    ]);
    expect(
      (
        await client.query(
          `SELECT state FROM "Ask" WHERE id IN ($1,$2,$3) ORDER BY id`,
          [cutoverId(40), cutoverId(41), cutoverId(42)],
        )
      ).rows.map((r) => r.state),
    ).toEqual(["answered", "unknown", "queued"]);
    const { modelAsks } = await import("../src/server/ai/model-asks");
    const { askEnvelope, inputHashOf } =
      await import("../src/server/kernel/envelope");
    const ready = (
      await client.query(`SELECT * FROM "Ask" WHERE id=$1`, [cutoverId(69)])
    ).rows[0];
    const kind = modelAsks.find(
      (k) => k.feature === "field-suggestion.choice",
    )!;
    expect(ready).toMatchObject({
      feature: kind.feature,
      executor: null,
      cancelledAt: null,
      state: "queued",
    });
    expect(ready.input).toEqual(askEnvelope(kind, ready.input.input));
    expect(ready.inputHash).toBe(
      await inputHashOf(askEnvelope(kind, ready.input.input)),
    );
    expect(
      (
        await client.query(
          `SELECT "cancelledAt" IS NOT NULL cancelled,"lastError" FROM "Ask" WHERE id=$1`,
          [cutoverId(42)],
        )
      ).rows[0],
    ).toMatchObject({
      cancelled: true,
      lastError: expect.stringContaining("incomplete canonical input"),
    });
    expect(
      (
        await client.query(
          `SELECT receipt,sequence FROM "AskScope" WHERE "askId"=$1 AND "scopeKind"='run'`,
          [cutoverId(40)],
        )
      ).rows,
    ).toEqual([{ receipt: { retained: "requester" }, sequence: 7 }]);
    expect(
      (
        await client.query(
          `SELECT value,"actorKind" FROM "Decision" WHERE subject=$1 AND field='book'`,
          [`purchaseEvent:${cutoverId(3)}`],
        )
      ).rows,
    ).toEqual([{ value: true, actorKind: "member" }]);
    expect(
      (
        await client.query(
          `SELECT value FROM "Decision" WHERE subject=$1 AND kind='veto' ORDER BY value`,
          [`product:${cutoverId(13)}`],
        )
      ).rows.map((r) => r.value),
    ).toEqual(["synthetic-dismissed", "synthetic-proposal"]);
    expect(
      (
        await client.query(
          `SELECT subject,value,"actorKind" FROM "Decision" WHERE subject LIKE 'connection/%' ORDER BY subject`,
        )
      ).rows,
    ).toEqual([
      {
        subject: `connection/email-purchase:${cutoverId(16)}:${cutoverId(4)}`,
        value: true,
        actorKind: "member",
      },
      {
        subject: `connection/email-purchase:${cutoverId(16)}:${cutoverId(5)}`,
        value: false,
        actorKind: "member",
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT subject,other,kind FROM "Decision" WHERE channel='identity'`,
        )
      ).rows,
    ).toEqual([
      {
        subject: `financialTransaction:${cutoverId(3)}`,
        other: `financialTransaction:${cutoverId(56)}`,
        kind: "distinct",
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT kind,"actorKind" FROM "Decision" WHERE subject=$1 AND field='categoryId' ORDER BY at DESC,id DESC LIMIT 1`,
          [`product:${cutoverId(13)}`],
        )
      ).rows,
    ).toEqual([{ kind: "release", actorKind: "system" }]);
    expect(
      (
        await client.query(
          `SELECT output->>'value' value FROM "Answer" WHERE "inputHash"=$1`,
          [`legacy:field:financialTransaction:${cutoverId(56)}:amount`],
        )
      ).rows,
    ).toEqual([{ value: "2000" }]);
    expect(
      (
        await client.query(
          `SELECT value FROM "Decision" WHERE subject=$1 AND field='amount' AND kind='set'`,
          [`financialTransaction:${cutoverId(56)}`],
        )
      ).rows,
    ).toEqual([]);
    const held = (
      await client.query(
        `SELECT field,kind,"actorKind","actorId" FROM "Decision" WHERE subject=$1 AND id::text LIKE 'ffffffff%' ORDER BY field`,
        [`product:${cutoverId(13)}`],
      )
    ).rows;
    expect(held).toEqual([]);
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
    ).toBe(5);
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
      "money totals": `UPDATE "ManualEntry" SET payload=jsonb_set(payload,'{values,purchaseId}',to_jsonb('${cutoverId(5)}'::text)) WHERE payload->>'naturalKey'='legacy:${cutoverId(7)}'`,
      recordKey: 'DELETE FROM "RecordKey"',
      manualEntry: 'DELETE FROM "ManualEntry"',
      binding: 'DELETE FROM "EvidenceBinding"',
      scope: 'DELETE FROM "ScopeState"',
      decision: 'DELETE FROM "Decision"',
      ask: 'DELETE FROM "Ask"',
      answer: 'DELETE FROM "Answer"',
      askScope: 'DELETE FROM "AskScope"',
      "absorbed scope": 'UPDATE "RecordKey" SET "mergedAt"=NULL',
      "accepted occurrence":
        'DELETE FROM "RecordKey" WHERE "scopeKey"=\'' + cutoverId(63) + "'",
      "audit count": 'DELETE FROM archive."AuditLog_authority_preimage"',
      "evaluation count": 'DELETE FROM "Ask"',
      "requester count": 'DELETE FROM "AskScope"',
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
        ).toBe(5);
        checked++;
      }
    }
    expect(checked).toBe(18);
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
    const { tracePool } = await import("../src/server/db/db-pg-tracing");
    const pool = tracePool(
      new Pool({ connectionString: databaseUrl, max: 4 }),
      "strong",
    );
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
      const { claimAsks } = await import("../src/server/kernel/claim");
      const runnable = kernel.registry.asks.get("field-suggestion.choice")!;
      const claimed = await claimAsks(database, [runnable], 10);
      expect(claimed.map((a) => a.id)).toContain(cutoverId(69));
      expect(claimed.map((a) => a.id)).not.toContain(cutoverId(42));
      await client.query(
        `UPDATE "Ask" SET "claimToken"=NULL,"claimDeadline"=NULL WHERE id=$1`,
        [cutoverId(69)],
      );

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
      const { startPass, runOnePass } =
        await import("../src/server/kernel/pass");
      const { versionSweepPass } = await import("../src/server/kernel/drift");
      const bankScopes = {
        ...kernel.registry,
        reconcilers: new Map([
          ["bankEvent", kernel.registry.reconcilers.get("bankEvent")!],
        ]),
      };
      const sweep = versionSweepPass(() => bankScopes);
      await startPass(database, sweep);
      const sweepOnly = {
        ...kernel.registry,
        passes: new Map([[sweep.name, sweep]]),
      };
      for (let page = 0; page < scopes.length + 2; page++)
        if (!(await runOnePass(database, sweepOnly))) break;
      expect(
        (
          await client.query(
            `SELECT version FROM "ScopeState" WHERE "scopeKind"='bankEvent' AND "scopeKey"=$1`,
            [cutoverId(18)],
          )
        ).rows[0].version,
      ).toBe(1);
      expect(
        (
          await client.query(
            `SELECT version FROM "ScopeState" WHERE "scopeKind"='bankEvent' AND "scopeKey"=$1`,
            [`manual:${cutoverId(56)}`],
          )
        ).rows[0].version,
      ).toBe(1);
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
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM "EvidenceBinding" WHERE "scopeKind"='bankEvent' AND "scopeKey"=$1 AND basis='baseline' AND "eventKey" LIKE 'baseline:empty:%'`,
            [cutoverId(18)],
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
      const { createPurchaseEventRecord, updatePurchaseEventRecords } =
        await import("../src/server/domains/financial-transaction/repo/purchase-event-mutations");
      const { systemActor } = await import("@cubby/schemas/context");
      const { vendorId, purchaseId } =
        await import("@cubby/schemas/identifiers");
      const newPurchase = await createPurchaseEventRecord(
        database,
        "purchase",
        {
          vendorId: vendorId.parse(cutoverId(1)),
          date: "2026-03-01",
          statedTotal: 2500n,
        },
        systemActor(),
      );
      const newLine = await createPurchaseEventRecord(
        database,
        "expense",
        {
          name: "Synthetic later Email line",
          purchaseId: newPurchase.id,
          cost: 2500n,
          costType: "materials",
          date: "2026-03-01",
        },
        systemActor(),
      );
      await updatePurchaseEventRecords(
        database,
        "expense",
        [{ id: newLine.id, values: { cost: 2600n } }],
        systemActor(),
      );
      const oldScopeLine = await createPurchaseEventRecord(
        database,
        "expense",
        {
          name: "Synthetic later Email line in legacy order",
          purchaseId: purchaseId.parse(cutoverId(62)),
          cost: 700n,
          costType: "materials",
          date: "2026-03-01",
        },
        systemActor(),
      );
      expect(
        (
          await client.query(
            `SELECT "costMinor"::text cost FROM "Expense" WHERE id=$1`,
            [newLine.id],
          )
        ).rows,
      ).toEqual([{ cost: "2600" }]);
      expect(
        (
          await client.query(
            `SELECT "costMinor"::text cost FROM "Expense" WHERE id=$1`,
            [oldScopeLine.id],
          )
        ).rows,
      ).toEqual([{ cost: "700" }]);
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM "Drift" WHERE "scopeKind"='purchaseEvent' AND "scopeKey" IN ($1,$2)`,
            [cutoverId(62), newPurchase.id],
          )
        ).rows[0].n,
      ).toBe(0);
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
    await client.query(`DROP TABLE "ConnectionCandidateEvidence"`);
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
    ).toBe(3);
    expect(
      aggregates.find(
        (r) => r.mapping === "transactions with multiple accepting occurrences",
      )?.rows,
    ).toBe(1);
    expect(
      aggregates.find((r) => r.mapping === "occurrences left unbound")?.rows,
    ).toBe(0);
    expect(result.stdout).not.toContain(cutoverId(13));
    expect(result.stdout).not.toContain("cutover@example.invalid");
    expect(
      (await client.query(`SELECT count(*)::int n FROM "Ask"`)).rows[0].n,
    ).toBe(0);
  });
});

it("lets current stored authority defeat a synthesized review in both directions", async () => {
  await withMigrationDatabase(async (client, databaseUrl) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await seedCutoverPredecessor(client);
    const { generateShortcode } = await import("@cubby/shared");
    for (const n of [82, 83]) {
      const code = generateShortcode("productCategory");
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'productCategory',$2)`,
        [cutoverId(n), code],
      );
      await client.query(
        `INSERT INTO "ProductCategory" (id,shortcode,name) VALUES ($1,$2,'Synthetic category')`,
        [cutoverId(n), code],
      );
    }
    for (const [n, suggestion, authority] of [
      [80, 87, "automatic"],
      [81, 85, null],
    ]) {
      const code = generateShortcode("product");
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'product',$2)`,
        [cutoverId(Number(n)), code],
      );
      await client.query(
        `INSERT INTO "Product" (id,shortcode,name,"categoryId") VALUES ($1,$2,'Synthetic authority product',$3)`,
        [cutoverId(Number(n)), code, cutoverId(83)],
      );
      await client.query(
        `INSERT INTO "AuditLog" ("entityKind","entityId",action,changes,"userId",authority,"createdAt") VALUES ('product',$1,'update',jsonb_build_object('categoryId',jsonb_build_object('to',$2::text)),'synthetic-cutover',$3,'2026-02-01')`,
        [cutoverId(Number(n)), cutoverId(83), authority],
      );
      await client.query(
        `INSERT INTO "Suggestion" (id,"publicationKey",family,subject,judgment,entity,"recordId",field,"suggestedValue","confirmedValue",model,decisions,"acceptanceReceipt","createdAt","updatedAt") VALUES ($1,$2,'field','{}','{}','product',$3,'categoryId',to_jsonb($4::text),jsonb_build_object('present',true,'value',$4::text),'synthetic-model','[]','{"mode":"member"}','2026-01-01','2026-01-02')`,
        [
          cutoverId(Number(suggestion)),
          `synthetic:authority:${n}`,
          cutoverId(Number(n)),
          cutoverId(82),
        ],
      );
    }
    await migrateDatabase(db);
    expect(
      (
        await client.query(
          `SELECT kind,value FROM "Decision" WHERE subject=$1 AND field='categoryId' ORDER BY at DESC,id DESC LIMIT 1`,
          [`product:${cutoverId(80)}`],
        )
      ).rows,
    ).toEqual([{ kind: "release", value: null }]);
    expect(
      (
        await client.query(
          `SELECT kind,value FROM "Decision" WHERE subject=$1 AND field='categoryId' ORDER BY at DESC,id DESC LIMIT 1`,
          [`product:${cutoverId(81)}`],
        )
      ).rows,
    ).toEqual([{ kind: "set", value: cutoverId(83) }]);
    const { createDatabase } =
      await import("../src/server/db/database-runtime");
    const { relationalSchema } = await import("../src/server/db/schema");
    const { tracePool } = await import("../src/server/db/db-pg-tracing");
    const pool = tracePool(
      new Pool({ connectionString: databaseUrl, max: 4 }),
      "strong",
    );
    const q = drizzle({ client: pool, relations: relationalSchema });
    const database = createDatabase(() => ({
      client: q,
      withConnection: async (fn) => {
        const c = await pool.connect();
        try {
          return await fn(drizzle({ client: c, relations: relationalSchema }));
        } finally {
          c.release();
        }
      },
    }));
    try {
      const { createKernel } = await import("../src/server/kernel/api");
      const { KERNEL_MODULES } = await import("../src/server/kernel/modules");
      const kernel = createKernel(KERNEL_MODULES);
      const result = await kernel.reconcileNow(database, [
        { kind: "fields", key: `product:${cutoverId(80)}` },
        { kind: "fields", key: `product:${cutoverId(81)}` },
      ]);
      expect(result.filter((r) => r.status === "failed")).toEqual([]);
      expect(
        (
          await client.query(
            `SELECT "categoryId" FROM "Product" WHERE id IN ($1,$2) ORDER BY id`,
            [cutoverId(80), cutoverId(81)],
          )
        ).rows,
      ).toEqual([{ categoryId: cutoverId(83) }, { categoryId: cutoverId(83) }]);
    } finally {
      await pool.end();
    }
  });
});

it("matches the registered model feature envelope catalog", async () => {
  const { modelAsks } = await import("../src/server/ai/model-asks");
  const { acceptedInputCutoverSql } =
    await import("./accepted-input-cutover-select");
  const { z } = await import("zod");
  const catalog = z
    .array(
      z.object({
        feature: z.string(),
        promptVersion: z.string(),
        policy: z.json(),
      }),
    )
    .parse(JSON.parse(acceptedInputCutoverSql().split("$features$")[1]!));
  const { KERNEL_MODULES } = await import("../src/server/kernel/modules");
  const { buildRegistry } = await import("../src/server/kernel/registry");
  const projection = acceptedInputCutoverSql().split("), record_ids AS (")[0]!;
  for (const r of buildRegistry(KERNEL_MODULES).reconcilers.values())
    for (const target of r.writes) {
      if (!target.columns.length || target.name === "EvidenceBinding") continue;
      const recordLine = projection
        .split("\n")
        .find((line) => line.includes(`FROM "${target.name}" r`));
      expect(recordLine).toBeDefined();
      for (const column of target.columns)
        expect(recordLine).toContain(`'${column}'`);
    }
  expect(catalog).toEqual(
    modelAsks.map((a) => ({
      feature: a.feature,
      promptVersion: a.promptVersion,
      policy: a.policy,
    })),
  );
});

it("retires a historical merge even when its deletion timestamp is absent", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await seedCutoverPredecessor(client);
    await client.query(
      `ALTER TABLE "Entity" DROP CONSTRAINT "Entity_merged_is_deleted_check"`,
    );
    await client.query(`UPDATE "Entity" SET "deletedAt"=NULL WHERE id=$1`, [
      cutoverId(6),
    ]);
    await migrateDatabase(db);
    expect(
      (
        await client.query(
          `SELECT "entityId","mergedAt" IS NOT NULL retired FROM "RecordKey" WHERE "naturalKey"=$1`,
          [`legacy:${cutoverId(6)}`],
        )
      ).rows,
    ).toEqual([{ entityId: cutoverId(4), retired: true }]);
  });
});

it("binds an accepting occurrence even under a nullable historical disposition", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await seedCutoverPredecessor(client);
    expect(
      (
        await client.query(
          `SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='SourceOccurrence' AND column_name='disposition'`,
        )
      ).rows,
    ).toEqual([{ is_nullable: "NO" }]);
    await client.query(
      `ALTER TABLE "SourceOccurrence" ALTER COLUMN disposition DROP NOT NULL`,
    );
    await client.query(
      `UPDATE "SourceOccurrence" SET disposition=NULL WHERE id=$1`,
      [cutoverId(63)],
    );
    await migrateDatabase(db);
    expect(
      (
        await client.query(
          `SELECT "entityId" FROM "RecordKey" WHERE "scopeKind"='bankEvent' AND "scopeKey"=$1`,
          [cutoverId(63)],
        )
      ).rows,
    ).toEqual([{ entityId: cutoverId(3) }]);
  });
});

it("preserves a malformed legacy decision container without aborting deployment", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await seedCutoverPredecessor(client);
    await client.query(
      `UPDATE "Suggestion" SET decisions='{}',suppression='{"scope":"link","candidateKey":"synthetic"}' WHERE id=$1`,
      [cutoverId(67)],
    );
    await migrateDatabase(db);
    expect(
      (
        await client.query(
          `SELECT output->'legacy'->'decisions' preserved FROM "Answer" WHERE "inputHash"=$1`,
          [`legacy:Suggestion:${cutoverId(67)}`],
        )
      ).rows,
    ).toEqual([{ preserved: {} }]);
  });
});
