import {
  aiRefreshProgress,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { claimWorkflowRun } from "./lifecycle";

// A boolean admission guard must not transfer retained Run payloads. Narrow
// and full reads must keep the same running-status and current-attempt fence.
describe("Workflow Run claim projections", () => {
  const ctx = withTestDb();

  it("bounds admission payload while preserving cancellation and attempt fences", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "scheduled",
      status: "running",
    });
    const input = aiRefreshRunInput.parse({
      kind: "ai_refresh",
      activation: {
        release: `synthetic-${"x".repeat(100_000)}`,
        manifest: {},
        activatedAt: "2026-10-01T12:00:00Z",
        enabled: true,
      },
    });
    await getDb(ctx.db)
      .update(run)
      .set({ input, progress: aiRefreshProgress.parse({ attempt: 2 }) })
      .where(eq(run.id, id));
    const params = { runId: id, attempt: 2 };
    const narrow = await claimWorkflowRun(ctx.db, params, "id");
    expect(JSON.stringify(narrow).length).toBeLessThan(100);
    expect(narrow).toEqual({ id });
    expect(await claimWorkflowRun(ctx.db, params)).toMatchObject({ id, input });
    for (const attempt of [1, 3]) {
      expect(
        await claimWorkflowRun(ctx.db, { runId: id, attempt }, "id"),
      ).toBeNull();
      expect(await claimWorkflowRun(ctx.db, { runId: id, attempt })).toBeNull();
    }
    for (const status of [
      "failed",
      "completed",
      "paused",
      "paused_auth",
    ] as const) {
      await getDb(ctx.db).update(run).set({ status }).where(eq(run.id, id));
      expect(await claimWorkflowRun(ctx.db, params, "id")).toBeNull();
      expect(await claimWorkflowRun(ctx.db, params)).toBeNull();
    }
    expect(
      await claimWorkflowRun(
        ctx.db,
        { runId: crypto.randomUUID(), attempt: 2 },
        "id",
      ),
    ).toBeNull();
  });
});
