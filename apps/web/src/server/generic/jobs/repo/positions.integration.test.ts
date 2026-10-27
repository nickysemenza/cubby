import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

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

  it("counts earlier due siblings in the same kind and Run class", async () => {
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
    expect(
      await dueJobPositions(
        ctx.db,
        rows.map((row) => row.id),
      ),
    ).toEqual(
      new Map([
        [rows[0]!.id, 1],
        [rows[1]!.id, 2],
        [rows[2]!.id, 0],
        [rows[4]!.id, 0],
      ]),
    );
    expect(await dueJobPositions(ctx.db, [])).toEqual(new Map());
  });
});
