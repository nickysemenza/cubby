import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Undecided machinery output goes; a decision, an application, a Run and AI
// cost evidence stay. Wish rows and everything hanging off them go.
it("retires cut features' undecided output and keeps decided work, Runs and cost evidence", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261109072002_run_finding_conflict_payload",
    });
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-retire', 'Synthetic member', 'retire@example.test')`,
    );
    const run = async (
      n: number,
      purpose: string,
      trigger: string,
      status: string,
    ) => {
      await client.query(
        `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'run', $2)`,
        [id(n), `RUN-SYNR${n}`],
      );
      await client.query(
        `INSERT INTO "Run" (id, shortcode, "actorName", trigger, purpose, "actorUserId", "actorEmail", status)
         VALUES ($1, $2, 'Synthetic member', $3, $4, 'synthetic-retire', 'retire@example.test', $5)`,
        [id(n), `RUN-SYNR${n}`, trigger, purpose, status],
      );
    };
    await run(1, "ai_refresh", "scheduled", "failed");
    await run(2, "mail_search", "scheduled", "failed");
    await run(3, "sweep", "manual", "failed");

    const suggestion = async (
      n: number,
      family: string,
      scope: string | null,
      options: {
        decided?: boolean;
        status?: string;
        entity?: string;
        evaluationId?: string;
      } = {},
    ) => {
      const entity = options.entity ?? "product";
      await client.query(
        `INSERT INTO "Suggestion" (id, "publicationKey", family, subject, judgment, decisions, entity, "recordId", status, active, "evaluationId")
         VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, $5::jsonb, $6, $7, $8, true, $9)`,
        [
          id(n),
          `synthetic:${n}`,
          family,
          JSON.stringify(scope ? { kind: family, scope } : { kind: family }),
          options.decided ? JSON.stringify([{ verdict: "correct" }]) : "[]",
          entity,
          id(n + 500),
          options.status ?? "pending",
          options.evaluationId ?? null,
        ],
      );
    };
    await suggestion(10, "recommendation", "connection.expense-project");
    // Seeded after the evaluation below so the foreign key holds.
    const decidedLinkedEmailPurchase = () =>
      suggestion(11, "recommendation", "connection.email-purchase", {
        decided: true,
        evaluationId: id(20),
      });
    await suggestion(12, "recommendation", "connection.product-expense", {
      status: "applied",
    });
    await suggestion(13, "product_pair", null);
    await suggestion(14, "product_pair", null, { decided: true });
    await suggestion(15, "field", null);

    const evaluation = async (
      n: number,
      kind: string,
      runId: string | null,
      state: string,
    ) => {
      await client.query(
        `INSERT INTO "AiEvaluation" (id, "runId", "workKey", feature, target, provenance, snapshot, state)
         VALUES ($1, $2, $3, 'synthetic', jsonb_build_object('kind', $4::text, 'entity', 'product', 'recordId', $5::text),
                 '{"dependencies":[],"inputFingerprint":"synthetic"}', '{}', $6)`,
        [id(n), runId, `synthetic:${n}`, kind, id(n + 500), state],
      );
    };
    await evaluation(20, "connection", id(1), "queued");
    await decidedLinkedEmailPurchase();
    await client.query(
      `INSERT INTO "AiEvaluationRequest" ("runId", "evaluationId", receipt) VALUES ($1, $2, '{}')`,
      [id(1), id(20)],
    );
    await evaluation(21, "field", id(1), "queued");
    await evaluation(22, "email", id(1), "queued");

    for (const [key, state] of [
      ["transfer_pair_scan", "running"],
      ["connection_evaluate", "paused"],
      ["statement_generate", "running"],
    ] as const)
      await client.query(
        `INSERT INTO "RunStep" ("runId", key, label, position, state) VALUES ($1, $2, 'Synthetic', 0, $3)`,
        [id(3), key, state],
      );

    for (const [n, runN, state] of [
      [30, 1, "failed"],
      [31, 2, "failed"],
      [32, 3, "failed"],
    ] as const)
      await client.query(
        `INSERT INTO "Job" (key, kind, state, "runId", input) VALUES ($1, 'run.execute', $2, $3, '{}')`,
        [`synthetic:job:${n}`, state, id(runN)],
      );

    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'wish', 'WSH-SYNRETIRE'), ($2, 'product', 'PRD-SYNRETIRE')`,
      [id(40), id(41)],
    );
    await client.query(
      `INSERT INTO "Wish" (id, shortcode, name) VALUES ($1, 'WSH-SYNRETIRE', 'Synthetic wish')`,
      [id(40)],
    );
    await client.query(
      `INSERT INTO "SearchDocument" ("entityKind", "entityId", title, body, "semanticText", "normalizedText", "searchVector", "sourceHash")
       VALUES ('wish', $1, 'Synthetic', 'b', 's', 'n', ''::tsvector, 'h')`,
      [id(40)],
    );
    await client.query(
      `INSERT INTO "EntityLink" (id, kind, "fromEntityId", "toEntityId", "fromKind", "toKind")
       VALUES ($1, 'wishCandidate', $2, $3, 'wish', 'product')`,
      [id(42), id(40), id(41)],
    );
    await client.query(
      `INSERT INTO "AuditLog" (id, "entityId", "entityKind", action, "userId")
       VALUES ($1, $2, 'wish', 'create', 'synthetic-retire')`,
      [id(43), id(40)],
    );
    await client.query(
      `INSERT INTO "AiUsage" (id, "runId", "entityId", "entityKind", feature, operation, model, provider, "durationMs", "inputTokens", "outputTokens")
       VALUES ($1, $2, $3, 'wish', 'synthetic', 'synthetic', 'synthetic', 'openai', 1, 1, 1)`,
      [id(44), id(1), id(40)],
    );

    await migrateDatabase(db, {
      through: "20261109191634_retire_cut_features",
    });

    const ids = async (sql: string) =>
      (await client.query<{ id: string }>(sql)).rows.map((row) => row.id);
    expect(await ids(`SELECT id FROM "Suggestion" ORDER BY id`)).toEqual([
      id(11),
      id(12),
      id(14),
      id(15),
    ]);
    // The retained decided row loses only its pointer to the retired evaluation.
    expect(
      (
        await client.query(
          `SELECT "evaluationId" FROM "Suggestion" WHERE id = $1`,
          [id(11)],
        )
      ).rows,
    ).toEqual([{ evaluationId: null }]);
    expect(
      (
        await client.query(
          `SELECT key, state, meta->'retired' AS retired FROM "RunStep" WHERE "runId" = $1 ORDER BY key`,
          [id(3)],
        )
      ).rows,
    ).toEqual([
      { key: "connection_evaluate", state: "done", retired: true },
      { key: "statement_generate", state: "running", retired: null },
      { key: "transfer_pair_scan", state: "done", retired: true },
    ]);
    expect(await ids(`SELECT id FROM "AiEvaluation" ORDER BY id`)).toEqual([
      id(21),
      id(22),
    ]);
    expect(
      await ids(`SELECT "evaluationId" AS id FROM "AiEvaluationRequest"`),
    ).toEqual([]);
    const { rows: states } = await client.query<{ id: string; state: string }>(
      `SELECT id, state FROM "AiEvaluation" ORDER BY id`,
    );
    expect(states).toEqual([
      { id: id(21), state: "queued" },
      { id: id(22), state: "obsolete" },
    ]);
    expect(await ids(`SELECT id FROM "Run" ORDER BY id`)).toEqual([
      id(1),
      id(2),
      id(3),
    ]);
    expect(
      await ids(`SELECT "runId" AS id FROM "Job" ORDER BY "runId"`),
    ).toEqual([id(2), id(3)]);
    expect(await ids(`SELECT id FROM "Entity" WHERE kind = 'wish'`)).toEqual(
      [],
    );
    expect(await ids(`SELECT id FROM "EntityLink"`)).toEqual([]);
    expect(
      await ids(`SELECT id FROM "AuditLog" WHERE "entityKind" = 'wish'`),
    ).toEqual([]);
    expect(
      await ids(
        `SELECT "entityId" AS id FROM "SearchDocument" WHERE "entityKind" = 'wish'`,
      ),
    ).toEqual([]);
    const { rows: usage } = await client.query(
      `SELECT "entityId", "entityKind", "runId" FROM "AiUsage"`,
    );
    expect(usage).toEqual([{ entityId: null, entityKind: null, runId: id(1) }]);
  });
});
