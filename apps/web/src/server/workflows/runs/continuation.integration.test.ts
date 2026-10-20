import { runEntityId } from "@cubby/schemas/identifiers";
import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
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

import type { BackgroundQueueProducer } from "../background-queue-types";
import {
  handleBackgroundTask,
  productionBackgroundTaskPorts,
} from "../background-tasks/handle";
import { continueWorkflowRun } from "./continuation";
import type { WorkflowRunParams } from "./contract";
import { WorkflowInterruptedError } from "./execution";
import type { WorkflowLauncher } from "./launcher";
import { launchWorkflowRun } from "./lifecycle";

// A deploy must not replay a published page, lose its cursor, or let a stale
// boundary resurrect a cancelled Run. Cloudflare step replay must not allocate
// another successor after the first handoff's result was retained.
describe("Workflow deployment continuation", () => {
  const ctx = withTestDb();
  it("consumes an activation-pending initial launch without allocating an obsolete attempt", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
    });
    const messages: unknown[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            entries: Parameters<BackgroundQueueProducer["sendBatch"]>[0],
          ) => {
            messages.push(...[...entries].map((entry) => entry.body));
          },
        },
      }),
    );
    let activated = false;
    const launches: WorkflowRunParams[] = [];
    const launcher: WorkflowLauncher = {
      prepare: async () => {
        if (!activated)
          throw new WorkflowInterruptedError("activation_pending");
        return { deploymentVersion: "synthetic-current", activationEpoch: 1 };
      },
      create: async (_purpose, _id, params) => {
        launches.push(params);
      },
      status: async () => ({ state: "running", error: null }),
      terminate: async () => {},
    };
    try {
      expect(
        await launchWorkflowRun(
          ctx.db,
          { runId: id, purpose: "maintenance" },
          launcher,
        ),
      ).toMatchObject({ attempt: 0, pending: true });
      expect(launches).toEqual([]);
      const message = backgroundTaskMessageSchema.parse(messages[0]);
      activated = true;
      const ports = {
        ...productionBackgroundTaskPorts,
        continueWorkflow: (db: typeof ctx.db, params: WorkflowRunParams) =>
          continueWorkflowRun(db, params, launcher),
      };
      await handleBackgroundTask(ctx.db, message.task, ports);
      await handleBackgroundTask(ctx.db, message.task, ports);
      expect(launches).toEqual([
        {
          runId: id,
          attempt: 1,
          deploymentVersion: "synthetic-current",
          activationEpoch: 1,
        },
      ]);
    } finally {
      setCfEnv(undefined);
    }
  });
  const deliver = (params: WorkflowRunParams, launcher: WorkflowLauncher) =>
    handleBackgroundTask(
      ctx.db,
      {
        kind: "workflow.continue",
        ...params,
        runId: runEntityId.parse(params.runId),
        requestedAt: new Date().toISOString(),
      },
      {
        ...productionBackgroundTaskPorts,
        continueWorkflow: (db, input) =>
          continueWorkflowRun(db, input, launcher),
      },
    );

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
        currentVersion: async () => ({ version: deployed }),
        continue: async () => {
          await deliver(params, launcher);
        },
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
    expect(
      await advanceStepRun(ctx.db, params, drivers, launcher),
    ).toMatchObject({
      kind: "continue",
      summary: {
        phase: "synthetic-pages",
        pageProcessed: 1,
        cumulative: { processed: 1, total: null, failures: 0 },
        cursor: { page: 2 },
      },
    });
    expect(await boundary("page:1")).toBe(true);
    await deliver(params, launcher);
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
    ).toMatchObject({
      kind: "continue",
      summary: {
        phase: "synthetic-pages",
        pageProcessed: 1,
        cumulative: { processed: 2, total: null, failures: 0 },
        cursor: { page: 3 },
      },
    });
    expect(published).toEqual([null, "page-two"]);
    expect(await readRunSteps(ctx.db, id)).toMatchObject([
      { done: 2, cursor: "finished" },
    ]);
    await deliver(params, launcher);
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
        currentVersion: async () => ({ version: "synthetic-version-b" }),
        continue: async () => {
          await deliver({ runId: id, attempt: 1 }, launcher);
        },
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
