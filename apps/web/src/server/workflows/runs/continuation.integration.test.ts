import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { readRunSteps } from "~/server/domains/run/repo/run-step";
import {
  advanceStepRun,
  type StepRunDrivers,
} from "~/server/domains/run/service/step-run";
import { memoryDurableSteps } from "~/server/testing/durable-steps";
import { workflowDeploymentBoundary } from "~/server/workflows/deployment-boundary";

import { continueWorkflowRun } from "./continuation";
import type { WorkflowRunParams } from "./contract";
import type { WorkflowLauncher } from "./launcher";
import { launchWorkflowRun } from "./lifecycle";

// A deploy must not replay a published page, lose its cursor, or let a stale
// boundary resurrect a cancelled Run. Cloudflare step replay must not allocate
// another successor after the first handoff's result was retained.
describe("Workflow deployment continuation", () => {
  const ctx = withTestDb();

  it("hands off at the next boundary and resumes the committed cursor exactly once", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const launches: WorkflowRunParams[] = [];
    const launcher: WorkflowLauncher = {
      create: async (_purpose, _id, params) => {
        launches.push(params);
      },
      terminate: async () => {},
      status: async () => ({ state: "running", error: null }),
    };
    await launchWorkflowRun(
      ctx.db,
      { runId: id, purpose: "maintenance" },
      launcher,
    );
    const params = { runId: id, attempt: 1 };
    let deployed = "synthetic-version-a";
    const { steps } = memoryDurableSteps();
    const boundary = (name: string) =>
      workflowDeploymentBoundary(steps, {
        name,
        version: "synthetic-version-a",
        currentVersion: async () => deployed,
        continue: () => continueWorkflowRun(ctx.db, params, launcher),
      });
    const published: unknown[] = [];
    const drivers: StepRunDrivers = async () => [
      {
        key: "synthetic-pages",
        label: "Synthetic pages",
        page: async ({ step }) => {
          published.push(step.cursor);
          deployed = "synthetic-version-b";
          return {
            kind: "progress",
            delta: { done: 1 },
            cursor: step.cursor === null ? "page-two" : "finished",
            done: step.cursor !== null,
          };
        },
      },
    ];
    expect(await boundary("page:0")).toBe(false);
    expect(await advanceStepRun(ctx.db, params, drivers, launcher)).toEqual({
      kind: "continue",
    });
    expect(await boundary("page:1")).toBe(true);
    expect(await boundary("page:1")).toBe(true);
    expect(launches).toEqual([params, { runId: id, attempt: 2 }]);
    expect(await advanceStepRun(ctx.db, params, drivers, launcher)).toEqual({
      kind: "lost",
    });
    expect(
      await advanceStepRun(
        ctx.db,
        { runId: id, attempt: 2 },
        drivers,
        launcher,
      ),
    ).toEqual({ kind: "continue" });
    expect(published).toEqual([null, "page-two"]);
    expect(await readRunSteps(ctx.db, id)).toMatchObject([
      { done: 2, cursor: "finished" },
    ]);
    await continueWorkflowRun(ctx.db, params, launcher);
    expect(launches).toHaveLength(2);
  });

  it("does not reopen a cancellation at a changed-version boundary", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    let launches = 0;
    const launcher: WorkflowLauncher = {
      create: async () => {
        launches += 1;
      },
      terminate: async () => {},
      status: async () => ({ state: "running", error: null }),
    };
    await launchWorkflowRun(
      ctx.db,
      { runId: id, purpose: "maintenance" },
      launcher,
    );
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "failed",
        failureCode: "user_cancelled",
      })
      .where(eq(run.id, id));
    const { steps } = memoryDurableSteps();
    expect(
      await workflowDeploymentBoundary(steps, {
        name: "cancelled",
        version: "synthetic-version-a",
        currentVersion: async () => "synthetic-version-b",
        continue: () =>
          continueWorkflowRun(ctx.db, { runId: id, attempt: 1 }, launcher),
      }),
    ).toBe(true);
    expect(launches).toBe(1);
    expect(
      await getDb(ctx.db).query.run.findFirst({ where: eq(run.id, id) }),
    ).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
      progress: { attempt: 1 },
    });
  });
});
