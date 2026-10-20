import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { memoryDurableSteps } from "~/server/testing/durable-steps";

import type { BackgroundQueueProducer } from "./background-queue-types";
import { workflowDeploymentBoundary } from "./deployment-boundary";
import { runDeploymentBoundary } from "./runs/deployment";

// A retained unchanged decision must stay unchanged on replay, including a
// rollback; only a new boundary observes the replacement deployment. A lookup
// failure must not silently authorize another page of pinned code.
describe("Workflow deployment boundaries", () => {
  // Creating a successor in the predecessor's RPC ancestry can carry the
  // Worker loop depth forward. Queue acceptance must precede a fresh launch.
  it("queues successor launch without creating it in the predecessor invocation", async () => {
    let inlineLaunches = 0;
    const accepted: unknown[] = [];
    const env = fromPartial<Env>({
      CF_VERSION_METADATA: { id: "synthetic-a" },
      BACKGROUND_QUEUE: {
        sendBatch: async (
          messages: Parameters<BackgroundQueueProducer["sendBatch"]>[0],
        ) => {
          accepted.push(...[...messages].map((message) => message.body));
        },
      },
      AI_GATEWAY_EGRESS: {
        getByName: () =>
          fromPartial<ReturnType<Env["AI_GATEWAY_EGRESS"]["getByName"]>>({
            currentDeploymentVersion: async () => "synthetic-a",
            continueWorkflowRun: async () => {
              inlineLaunches += 1;
            },
          }),
      },
    });
    const params = {
      runId: "00000000-0000-4000-8000-000000000001",
      attempt: 1,
    };
    const durable = memoryDurableSteps();
    const boundary = runDeploymentBoundary(env, durable.steps, params);
    const summary = {
      phase: "generate",
      unit: "charges",
      pageProcessed: 20,
      pageFailures: 0,
      cumulative: { processed: 80, total: 200, failures: 0 },
      labels: { reused: 2, generated: 0 },
      cursor: { stepId: "00000000-0000-4000-8000-000000000002", page: 4 },
    };
    await expect(
      boundary("continue", true, { nextInstanceId: "RUN-4K7M-2", summary }),
    ).resolves.toBe(true);
    expect(durable.completed.get("handoff → RUN-4K7M-2 · continue")).toEqual({
      queued: true,
      nextInstanceId: "RUN-4K7M-2",
      summary,
    });
    expect(durable.completed.get("deployment guard · continue")).toMatchObject({
      handoff: true,
      reason: "instance budget",
    });
    expect(inlineLaunches).toBe(0);
    expect(accepted).toEqual([
      expect.objectContaining({
        queueType: "background",
        task: expect.objectContaining({
          kind: "workflow.continue",
          runId: params.runId,
          attempt: params.attempt,
        }),
      }),
    ]);
  });

  // A fresh instance may briefly lag the current DO during deploy propagation;
  // it must wait and recheck before allocating another zero-progress successor.
  it("waits for propagation at startup and rechecks before handing off", async () => {
    const { steps, sleeps } = memoryDurableSteps();
    let reads = 0;
    const resume = vi.fn(async () => {});
    const handedOff = await workflowDeploymentBoundary(steps, {
      name: "page:0",
      version: "synthetic-a",
      initial: true,
      currentVersion: async () =>
        ++reads === 1 ? "synthetic-b" : "synthetic-a",
      continue: resume,
    });
    expect(handedOff).toBe(false);
    expect(sleeps).toEqual([
      { name: "deployment-settle:page:0", durationMs: 30_000 },
    ]);
    expect(resume).not.toHaveBeenCalled();
  });

  // A lost create response followed by rollback must never authorize the
  // predecessor to run another page while its successor owns that checkpoint.
  it("keeps the handoff decision after a lost reply and rollback", async () => {
    const { steps } = memoryDurableSteps();
    let deployed = "synthetic-b";
    let replyLost = false;
    const successors = new Set<string>();
    const handedOff = await workflowDeploymentBoundary(steps, {
      name: "page:1",
      version: "synthetic-a",
      currentVersion: async () => deployed,
      continue: async () => {
        successors.add("synthetic-successor");
        if (!replyLost) {
          replyLost = true;
          deployed = "synthetic-a";
          throw new Error("Synthetic create response lost during rollback");
        }
      },
    });
    expect(handedOff).toBe(true);
    expect([...successors]).toEqual(["synthetic-successor"]);
  });

  // Cloudflare exceptions can permanently break one stub; retrying the RPC
  // on that same stub must not turn transient unavailability into a failed Run.
  it("acquires a fresh authority stub after a broken RPC", async () => {
    let first = true;
    let launches = 0;
    const env = fromPartial<Env>({
      CF_VERSION_METADATA: { id: "synthetic-a" },
      BACKGROUND_QUEUE: {
        sendBatch: async () => {
          launches += 1;
        },
      },
      AI_GATEWAY_EGRESS: {
        getByName: () => {
          let broken = false;
          return fromPartial<ReturnType<Env["AI_GATEWAY_EGRESS"]["getByName"]>>(
            {
              currentDeploymentVersion: async () => {
                if (broken) throw new Error("Synthetic broken stub");
                if (first) {
                  first = false;
                  broken = true;
                  throw new Error("Synthetic transient RPC failure");
                }
                return "synthetic-b";
              },
              continueWorkflowRun: async () => {
                launches += 1;
              },
            },
          );
        },
      },
    });
    const { steps } = memoryDurableSteps();
    const boundary = runDeploymentBoundary(env, steps, {
      runId: "00000000-0000-4000-8000-000000000001",
      attempt: 1,
    });
    await expect(boundary("page:0")).resolves.toBe(true);
    expect(launches).toBe(1);
  });

  it("replays the old decision and detects rollback at the next boundary", async () => {
    const { steps } = memoryDurableSteps();
    let version = "synthetic-b";
    const resume = vi.fn(async () => {});
    const check = (name: string) =>
      workflowDeploymentBoundary(steps, {
        name,
        version: "synthetic-b",
        currentVersion: async () => version,
        continue: resume,
      });
    expect(await check("page:0")).toBe(false);
    version = "synthetic-a";
    expect(await check("page:0")).toBe(false);
    expect(await check("page:1")).toBe(true);
    expect(await check("page:1")).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("fails closed on an unavailable version and still rotates at the instance bound", async () => {
    const { steps } = memoryDurableSteps();
    const currentVersion = vi.fn(async (): Promise<string> => {
      throw new Error("Synthetic version RPC unavailable");
    });
    const resume = vi.fn(async () => {});
    const input = {
      name: "page:0",
      version: "synthetic-a",
      currentVersion,
      continue: resume,
    };
    await expect(workflowDeploymentBoundary(steps, input)).rejects.toThrow(
      "Synthetic version RPC unavailable",
    );
    expect(resume).not.toHaveBeenCalled();
    expect(
      await workflowDeploymentBoundary(steps, { ...input, force: true }),
    ).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
  });
});
