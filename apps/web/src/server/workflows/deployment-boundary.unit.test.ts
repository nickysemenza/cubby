import { describe, expect, it, vi } from "vitest";

import { memoryDurableSteps } from "~/server/testing/durable-steps";

import { workflowDeploymentBoundary } from "./deployment-boundary";

// A retained unchanged decision must stay unchanged on replay, including a
// rollback; only a new boundary observes the replacement deployment. A lookup
// failure must not silently authorize another page of pinned code.
describe("Workflow deployment boundaries", () => {
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
