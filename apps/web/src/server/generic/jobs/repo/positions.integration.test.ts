import { eq, sql } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import {
  dueJobPositions,
  dueJobPositionsQuery,
} from "~/server/generic/jobs/repo/queue";

// List diagnostics must stay bounded by visible kinds, independently of the
// drain's global fairness. Ordinary correctness tests cannot expose that scan.
describe("visible Job positions", () => {
  const ctx = withTestDb();

  it("counts earlier due siblings in the same kind and Run class in one statement", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const rows: Awaited<ReturnType<typeof enqueueJob>>[] = [];
    for (let n = 0; n < 5; n++)
      rows.push(
        await enqueueJob(ctx.db, {
          key: `synthetic.position.${n}`,
          kind: "synthetic.position",
          input: {},
          priority: n === 4 ? 10 : 0,
          ...(n === 2 ? { runId } : {}),
        }),
      );
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(Date.now() + 60_000) })
      .where(eq(job.id, rows[3]!.id));
    const measured = await countTestDbQueries(() =>
      dueJobPositions(
        ctx.db,
        rows.map((row) => row.id),
      ),
    );
    expect(measured.queryCount).toBe(1);
    expect(measured.result).toEqual(
      new Map([
        [rows[0]!.id, 1],
        [rows[1]!.id, 2],
        [rows[2]!.id, 0],
        [rows[4]!.id, 0],
      ]),
    );
    expect(
      (await countTestDbQueries(() => dueJobPositions(ctx.db, []))).queryCount,
    ).toBe(0);
  });

  it(
    "keeps indexed position work independent of 50k unrelated due Jobs",
    { timeout: 30_000 },
    async () => {
      const visible = await enqueueJob(ctx.db, {
        key: "synthetic.visible",
        kind: "synthetic.visible",
        input: {},
      });
      const explain = async () => {
        const result = await getDb(ctx.db).execute(
          sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${dueJobPositionsQuery([visible.id])}`,
        );
        return z
          .array(
            z.object({
              "QUERY PLAN": z.array(z.object({ Plan: z.unknown() })),
            }),
          )
          .parse(result.rows)[0]!["QUERY PLAN"][0]!.Plan;
      };
      const before = await explain();
      // Scale-only fixture: valid Job defaults and atomic Entity identities,
      // matching the existing bulk-cancel regression's generate_series seed.
      // Pin later ordering and due time to the anchor rather than relying on
      // server/connection clocks during concurrent integration suites.
      await getDb(ctx.db).execute(sql`
      WITH anchor AS MATERIALIZED (SELECT "updatedAt", "availableAt" FROM "Job" WHERE id=${visible.id}::uuid),
      seeds AS MATERIALIZED (SELECT n, gen_random_uuid() AS id FROM generate_series(1,55000) n), identities AS (
        INSERT INTO "Entity" (id,kind,shortcode) SELECT id,'job','JOB-' || lpad(translate(to_hex(n),'0123456789abcdef','23456789ABCDEFGH'),10,'2') FROM seeds RETURNING id,shortcode
      ) INSERT INTO "Job" (id,shortcode,key,kind,input,"updatedAt","availableAt")
      SELECT i.id,i.shortcode,'synthetic.unrelated:' || s.n,CASE WHEN s.n <= 5000 THEN 'synthetic.visible' ELSE 'synthetic.unrelated' END,'{}'::jsonb,
        anchor."updatedAt" + interval '1 second',anchor."availableAt"
      FROM identities i JOIN seeds s ON s.id=i.id CROSS JOIN anchor`);
      await getDb(ctx.db).execute(sql`ANALYZE "Job"`);
      const after = await explain();
      const nodeSchema = z.object({
        "Relation Name": z.string().optional(),
        "Index Name": z.string().optional(),
        "Actual Rows": z.number().default(0),
        "Actual Loops": z.number().default(0),
        "Rows Removed by Filter": z.number().default(0),
        Plans: z.array(z.unknown()).default([]),
      });
      const work = (root: unknown) => {
        let rows = 0;
        const indexes: string[] = [];
        const visit = (value: unknown) => {
          const node = nodeSchema.parse(value);
          if (node["Relation Name"] === "Job")
            rows +=
              (node["Actual Rows"] + node["Rows Removed by Filter"]) *
              node["Actual Loops"];
          if (node["Index Name"]) indexes.push(node["Index Name"]);
          node.Plans.forEach(visit);
        };
        visit(root);
        return { rows, indexes };
      };
      expect(work(after).rows).toBeLessThanOrEqual(work(before).rows + 2);
      expect(work(after).indexes).toContain("Job_kind_position_idx");
      expect(await dueJobPositions(ctx.db, [visible.id])).toEqual(
        new Map([[visible.id, 0]]),
      );
    },
  );
});
