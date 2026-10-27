import { jobState } from "@cubby/schemas/job";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

import { drainDueJobs } from "../service/jobs";
import type { JobHandlers } from "../types";

const CLAIM_DELAY_SECONDS = 0.05;

// Production finding: serial batch claims on a CPU-saturated database spent
// the whole drain budget, so every embedding page released its claims unrun.
describe("batch claim budget", () => {
  const ctx = withTestDb();

  it(
    "executes the claimed prefix when claiming a full batch would exhaust the budget",
    { timeout: 30_000 },
    async () => {
      for (let index = 0; index < 40; index++)
        await enqueueJob(ctx.db, {
          key: `synthetic.slow-claim.${index}`,
          kind: "embedding.refresh",
          input: {},
        });
      const executed: number[] = [];
      const handlers: JobHandlers = {
        "embedding.refresh": {
          prepare: async () => {
            throw new Error("Expected batch execution");
          },
          batch: {
            size: 40,
            execute: async (_db, claims, { checkpoint }) => {
              executed.push(claims.length);
              await checkpoint(
                new Map(
                  claims.map((claim) => [
                    claim.id,
                    { status: "fulfilled", value: { page: { done: true } } },
                  ]),
                ),
              );
            },
          },
        },
      };

      // Each claim stands in for a contended production claim transaction:
      // 40 claims need ~2s, and the budget covers only half of them.
      // A function body cannot take bind parameters.
      const running = sql.raw(`'${jobState.enum.running}'`);
      await getDb(ctx.db).execute(sql`
        CREATE FUNCTION synthetic_slow_claim() RETURNS trigger AS $$
        BEGIN
          IF NEW.state = ${running} AND OLD.state <> ${running} THEN
            PERFORM pg_sleep(${sql.raw(String(CLAIM_DELAY_SECONDS))});
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await getDb(ctx.db).execute(sql`
        CREATE TRIGGER synthetic_slow_claim BEFORE UPDATE ON "Job"
        FOR EACH ROW WHEN (NEW.key LIKE 'synthetic.slow-claim.%')
        EXECUTE FUNCTION synthetic_slow_claim()`);
      try {
        await drainDueJobs(ctx.db, handlers, 40, 1_000, 1);
      } finally {
        await getDb(ctx.db).execute(
          sql`DROP TRIGGER synthetic_slow_claim ON "Job"`,
        );
        await getDb(ctx.db).execute(sql`DROP FUNCTION synthetic_slow_claim()`);
      }

      expect(executed.length).toBeGreaterThan(0);
      const completed = await getDb(ctx.db)
        .select({ id: job.id })
        .from(job)
        .where(
          and(eq(job.kind, "embedding.refresh"), eq(job.state, "completed")),
        );
      expect(completed.length).toBe(executed.reduce((a, b) => a + b, 0));
      expect(completed.length).toBeGreaterThan(0);
    },
  );
});
