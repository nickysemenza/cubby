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
  });
});
