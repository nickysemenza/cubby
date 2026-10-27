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

it("retires every uploaded vector id without an artifact and re-admits open refreshes", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0047_coarse_jobs_work_items" });
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(400 + n).padStart(12, "0")}`;
    const [served, quiet, legacy] = [id(1), id(2), id(3)];
    const [selectedJob, finishedJob, openJob, cleanupJob] = [
      id(4),
      id(5),
      id(6),
      id(7),
    ];
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES
       ($1,'product','PRD-SYNTH401'),($2,'product','PRD-SYNTH402'),
       ($3,'job','JOB-SYNTH40400'),($4,'job','JOB-SYNTH40500'),
       ($5,'job','JOB-SYNTH40600'),($6,'job','JOB-SYNTH40700')`,
      [served, quiet, selectedJob, finishedJob, openJob, cleanupJob],
    );
    const artifact = `"entityKind","entityId","embeddingText","embeddingHash",provider,model,dimensions`;
    await client.query(
      `INSERT INTO "EntityEmbedding" (id,${artifact},"artifactState","artifactHash","vectorHash") VALUES
       ($1,'product',$2,'Synthetic text','h1','openai','text-embedding-3-small',8,'selected','h1','v1'),
       ($3,'product',$4,'Synthetic text','h0','openai','text-embedding-3-small',8,'legacy',NULL,NULL)`,
      [selectedJob, served, legacy, quiet],
    );
    const input = (source: string, hash: string) =>
      JSON.stringify({
        entityKind: "product",
        entityId: source,
        hash,
        text: "Synthetic text",
        config: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 8,
        },
      });
    await client.query(
      `INSERT INTO "Job" (id,shortcode,key,kind,input,state,attempts,cursor) VALUES
       ($1,'JOB-SYNTH40400','embedding:product:a:h1','embedding.refresh',$5,'completed',0,NULL),
       ($2,'JOB-SYNTH40500','embedding:product:a:hx:retired','embedding.refresh',$6,'completed',0,NULL),
       ($3,'JOB-SYNTH40600','embedding:product:b:h2','embedding.refresh',$7,'running',1,'{"hash":"v2","mutationId":"m2","submittedAt":"2026-01-01"}'),
       ($4,'JOB-SYNTH40700','embedding-cleanup:x','embedding.cleanup','{}','queued',0,NULL)`,
      [
        selectedJob,
        finishedJob,
        openJob,
        cleanupJob,
        input(served, "h1"),
        input(served, "hx"),
        input(quiet, "h2"),
      ],
    );

    await migrateDatabase(db, { through: "0048_carry_drain_work" });

    const artifacts = await client.query(
      `SELECT id,"artifactState","deletedAt" IS NOT NULL AS deleted FROM "EntityEmbedding" ORDER BY id`,
    );
    expect(artifacts.rows).toEqual([
      { id: legacy, artifactState: "retired", deleted: true },
      { id: selectedJob, artifactState: "selected", deleted: false },
      { id: finishedJob, artifactState: "retired", deleted: true },
      { id: openJob, artifactState: "retired", deleted: true },
    ]);
    const items = await client.query(
      `SELECT drain,ref FROM "WorkItem" WHERE drain LIKE 'embedding:%' ORDER BY drain,ref`,
    );
    expect(items.rows).toEqual([
      { drain: "embedding:cleanup", ref: legacy },
      { drain: "embedding:cleanup", ref: finishedJob },
      { drain: "embedding:cleanup", ref: openJob },
      { drain: "embedding:refresh", ref: quiet },
    ]);
    const jobs = await client.query(
      `SELECT key FROM "Job" WHERE kind LIKE 'embedding.%' ORDER BY key`,
    );
    expect(jobs.rows).toEqual([
      { key: "embedding:cleanup" },
      { key: "embedding:refresh" },
    ]);
    expect(
      (
        await client.query(
          `SELECT id FROM "Entity" WHERE id = ANY($1::uuid[])`,
          [[selectedJob, finishedJob, openJob, cleanupJob]],
        )
      ).rows,
    ).toEqual([]);
  });
});

it("preserves unlimited retries for existing subject-owned and derived Jobs", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0046_coarse_jobs_work_items" });
    const kinds = [
      "image.cloud",
      "image.device",
      "image.device.wake",
      "derived.drain",
      "derived.reconcile",
      "run.execute",
    ];
    for (const [index, kind] of kinds.entries()) {
      const id = `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`;
      const shortcode = `JOB-SYNTH7${index}123`;
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'job',$2)`,
        [id, shortcode],
      );
      await client.query(
        `INSERT INTO "Job" (id,shortcode,key,kind,input,state,attempts,"maxAttempts",error,"availableAt")
        VALUES ($1,$2,$3,$3,'{}','retry_wait',2,3,'Synthetic retained failure','2026-01-02')`,
        [id, shortcode, kind],
      );
    }
    await migrateDatabase(db, { through: "0047_coarse_jobs_work_items" });
    const result = await client.query(
      `SELECT kind,attempts,"maxAttempts",error,"availableAt"::date::text AS ready,state FROM "Job" WHERE id = ANY($1::uuid[]) ORDER BY kind`,
      [
        kinds.map(
          (_, index) =>
            `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`,
        ),
      ],
    );
    expect(result.rows).toEqual(
      [...kinds].sort().map((kind) => ({
        kind,
        attempts: 2,
        maxAttempts: kind === "run.execute" ? 3 : null,
        error: "Synthetic retained failure",
        ready: "2026-01-02",
        state: "retry_wait",
      })),
    );
  });
});
