import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const runId = "00000000-0000-4000-8000-000000000101";
const evaluation = (n: number) =>
  `00000000-0000-4000-8000-${String(200 + n).padStart(12, "0")}`;

it("carries open AI evaluations into the drain states without losing paid results", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0047_coarse_jobs_work_items" });
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('synthetic-reviewer','Synthetic operator','reviewer@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run','RUN-SYNTH101')`,
      [runId],
    );
    await client.query(
      `INSERT INTO "Run" (id,shortcode,"actorName",trigger,"actorUserId","actorEmail",purpose,status)
      VALUES ($1,'RUN-SYNTH101','Synthetic operator','manual','synthetic-reviewer','reviewer@example.test','background','running')`,
      [runId],
    );
    // One slot per field: a retry wait, a paid result, a lone running row,
    // two running duplicates, and a running row behind a queued sibling.
    const rows: [number, string, string, string | null][] = [
      [1, "alpha", "retry_wait", null],
      [2, "beta", "result_ready", '{"answer":"Synthetic paid answer"}'],
      [3, "gamma", "running", null],
      [4, "delta", "running", null],
      [5, "delta", "running", null],
      [6, "epsilon", "queued", null],
      [7, "epsilon", "running", null],
    ];
    for (const [n, field, state, result] of rows)
      await client.query(
        `INSERT INTO "AiEvaluation"
        (id,"runId","workKey",feature,target,provenance,snapshot,state,result,"createdAt")
        VALUES ($1,$2,$3,'synthetic-feature',$4,'{}','{}',$5,$6,$7)`,
        [
          evaluation(n),
          runId,
          `synthetic-work-${n}`,
          JSON.stringify({ entity: "product", recordId: runId, field }),
          state,
          result,
          new Date(Date.UTC(2026, 0, 1, 0, n)),
        ],
      );

    // The per-evaluation Job of the retry wait carries its attempts and error.
    const oldJob = "00000000-0000-4000-8000-000000000301";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'job','JOB-SYNTH30123')`,
      [oldJob],
    );
    await client.query(
      `INSERT INTO "Job" (id,shortcode,key,kind,input,state,attempts,error,"availableAt")
      VALUES ($1,'JOB-SYNTH30123',$2,'ai.evaluation','{}','retry_wait',2,'Synthetic SQLSTATE 40001',$3)`,
      [oldJob, `ai-evaluation:${evaluation(1)}`, new Date("2026-01-02")],
    );

    await migrateDatabase(db, { through: "0048_carry_drain_work" });

    const after = await client.query<{
      id: string;
      state: string;
      result: unknown;
    }>(`SELECT id,state,result FROM "AiEvaluation" ORDER BY id`);
    expect(after.rows.map((row) => [row.id, row.state])).toEqual([
      [evaluation(1), "queued"],
      [evaluation(2), "result_ready"],
      [evaluation(3), "queued"],
      [evaluation(4), "obsolete"],
      [evaluation(5), "queued"],
      [evaluation(6), "queued"],
      [evaluation(7), "obsolete"],
    ]);
    expect(after.rows[1]!.result).toEqual({ answer: "Synthetic paid answer" });

    const items = await client.query(
      `SELECT ref,drain,priority,attempts,"lastError","readyAt" FROM "WorkItem"
       WHERE target = 'ai.evaluation' ORDER BY ref`,
    );
    expect(items.rows).toEqual(
      [1, 2, 3, 5, 6].map((n) =>
        expect.objectContaining({
          ref: evaluation(n),
          drain: "ai-evaluation:synthetic-feature",
          priority: 0,
          attempts: n === 1 ? 2 : 0,
          lastError: n === 1 ? "Synthetic SQLSTATE 40001" : null,
        }),
      ),
    );
    expect(items.rows[0]!.readyAt).toEqual(new Date("2026-01-02"));
    const jobs = await client.query(
      `SELECT j.key,j.kind,j.state,j."maxAttempts",e.kind AS identity,
        EXISTS (SELECT 1 FROM "JobInvalidationCapture" c WHERE c.key = j.key AND NOT c.observed) AS woken
       FROM "Job" j LEFT JOIN "Entity" e ON e.id = j.id
       WHERE j.kind = 'ai.evaluation' ORDER BY j.key`,
    );
    expect(jobs.rows).toEqual([
      {
        key: "ai-evaluation:synthetic-feature",
        kind: "ai.evaluation",
        state: "queued",
        maxAttempts: null,
        identity: "job",
        woken: true,
      },
    ]);
    expect(
      (await client.query(`SELECT 1 FROM "Entity" WHERE id = $1`, [oldJob]))
        .rowCount,
    ).toBe(0);
  });
});
