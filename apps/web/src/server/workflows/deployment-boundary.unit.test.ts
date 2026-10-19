import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { memoryDurableSteps } from "~/server/testing/durable-steps";

import { workflowDeploymentBoundary } from "./deployment-boundary";
import { runDeploymentBoundary } from "./runs/deployment";

// A retained unchanged decision must stay unchanged on replay, including a
// rollback; only a new boundary observes the replacement deployment. A lookup
// failure must not silently authorize another page of pinned code.
describe("Workflow deployment boundaries", () => {
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
