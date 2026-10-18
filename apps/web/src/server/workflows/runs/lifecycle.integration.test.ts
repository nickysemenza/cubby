import {
  aiRefreshProgress,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run, runControlEvent } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { controlWorkflowRun } from "./control";
import type { WorkflowLauncher } from "./launcher";
import { claimWorkflowRun, launchWorkflowRun } from "./lifecycle";

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

// The same paid override must release every funding-paused Workflow, while
// never turning an unrelated authorization pause into permission to spend.
describe("Workflow paid funding controls", () => {
  const ctx = withTestDb();
  it.each(["mail_discovery", "suggestion_sweep"] satisfies Parameters<
    typeof controlWorkflowRun
  >[3][])(
    "relaunches a funding-paused %s with a recorded member grant",
    async (purpose) => {
      await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic funding member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const id = await ensureRun(ctx.db, ctx.actor, {
        purpose,
        trigger: "scheduled",
        status: "running",
      });
      await getDb(ctx.db)
        .update(run)
        .set({ status: "paused_auth", failureCode: "execution_limit" })
        .where(eq(run.id, id));
      const row = await getDb(ctx.db).query.run.findFirst({
        where: eq(run.id, id),
      });
      if (!row) throw new Error("Synthetic funding Run missing");
      const launches: string[] = [];
      const launcher: WorkflowLauncher = {
        create: async (target) => {
          launches.push(target);
        },
        terminate: async () => {},
        status: async () => ({ state: "missing", error: null }),
      };
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: row.shortcode, action: "run_now_paid" },
        purpose,
        launcher,
      );
      expect(launches).toEqual([purpose]);
      expect(
        await getDb(ctx.db).query.run.findFirst({ where: eq(run.id, id) }),
      ).toMatchObject({ status: "running" });
      expect(
        await getDb(ctx.db)
          .select({ action: runControlEvent.action })
          .from(runControlEvent)
          .where(eq(runControlEvent.runId, id)),
      ).toEqual([{ action: "run_now_paid" }]);
      await getDb(ctx.db)
        .update(run)
        .set({ status: "paused_auth", failureCode: "authorization_required" })
        .where(eq(run.id, id));
      await expect(
        controlWorkflowRun(
          ctx.db,
          ctx.actor,
          { runPublicId: row.shortcode, action: "run_now_paid" },
          purpose,
          launcher,
        ),
      ).rejects.toThrow("funding-paused");
      expect(launches).toEqual([purpose]);
    },
  );

// CUBBY-1E8: recovery paths race to relaunch the same Run. The loser must see
// "already running or ended" as a no-op, not throw on an unrelated request.
describe("Automatic Workflow relaunch", () => {
  const ctx = withTestDb();
  const created: string[] = [];
  const launcher: WorkflowLauncher = {
    create: async (_purpose, id) => {
      created.push(id);
    },
    terminate: async () => {},
    status: async () => ({ state: "running", error: null }),
  };

  it("launches once when two automatic recoveries race, and never reopens an ended Run", async () => {
    created.length = 0;
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "scheduled",
      status: "running",
    });
    const recover = () =>
      launchWorkflowRun(
        ctx.db,
        { runId: id, purpose: "ai_refresh", automatic: true },
        launcher,
      );
    const outcomes = await Promise.all([recover(), recover()]);
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
    expect(created).toHaveLength(1);
    // A later recovery while the first attempt still runs is also a no-op.
    expect(await recover()).toBeNull();
    for (const status of ["completed", "paused"] as const) {
      await getDb(ctx.db).update(run).set({ status }).where(eq(run.id, id));
      expect(await recover()).toBeNull();
    }
    expect(created).toHaveLength(1);
    // A member's explicit launch of a running Run still refuses loudly.
    await getDb(ctx.db)
      .update(run)
      .set({ status: "running" })
      .where(eq(run.id, id));
    await expect(
      launchWorkflowRun(ctx.db, { runId: id, purpose: "ai_refresh" }, launcher),
    ).rejects.toThrow("This Run is already running");
  });
});
