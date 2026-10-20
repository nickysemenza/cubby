import { describe, expect, it } from "vitest";

import { memoryDurableSteps } from "~/server/testing/durable-steps";

import { runStepRunWorkflow, type StepRunWork } from "./step-run-execution";

const work = (overrides: Partial<StepRunWork> = {}): StepRunWork => ({
  advance: async () => ({ kind: "finished" }),
  boundary: async () => false,
  wait: async () => {},
  fail: async () => false,
  recover: async () => {},
  ...overrides,
});

describe("step Run Workflow failure and invocation boundaries", () => {
  // The SQL wrapper must not replace the original error, or hide the
  // Postgres cause when a fresh failure-recording attempt succeeds.
  it("records both errors after a failure write fails", async () => {
    const original = new Error("Synthetic provider invocation exhausted");
    const database = new Error(
      "Failed query: update synthetic Run; params: failed",
      {
        cause: Object.assign(new Error("Synthetic connection closed"), {
          code: "08006",
        }),
      },
    );
    const messages: string[] = [];
    await expect(
      runStepRunWorkflow(
        memoryDurableSteps().steps,
        work({
          advance: async () => {
            throw original;
          },
          fail: async (message) => {
            messages.push(message);
            if (messages.length === 1) throw database;
            return true;
          },
        }),
      ),
    ).rejects.toThrow(original.message);
    expect(messages.at(-1)).toContain(original.message);
    expect(messages.at(-1)).toContain("Failed query: update synthetic Run");
    expect(messages.at(-1)).toContain("08006");
    expect(messages.at(-1)).toContain("Synthetic connection closed");
  });

  // Workflow status only retains an error's message. Both complete chains
  // must survive there when even the failure record cannot reach Postgres.
  it("retains both errors in the terminal message when every failure write fails", async () => {
    const result = runStepRunWorkflow(
      memoryDurableSteps().steps,
      work({
        advance: async () => {
          throw new Error("Synthetic original failure");
        },
        fail: async () => {
          throw new Error("Failed query: synthetic UPDATE; params: 2", {
            cause: Object.assign(new Error("Synthetic statement timeout"), {
              code: "57014",
            }),
          });
        },
      }),
    );
    await expect(result).rejects.toThrow(
      /Synthetic original failure[\s\S]*Failed query: synthetic UPDATE[\s\S]*57014[\s\S]*Synthetic statement timeout/u,
    );
  });

  // A smaller page alone cannot reset an instance's cumulative subrequest
  // cap. Continuation must happen before the simulated cap, after checkpoint.
  it("continues a large sweep before its invocation exhausts subrequests", async () => {
    let left = 30_000;
    const driver = work({
      advance: async () => {
        left -= Math.min(left, 20);
        return { kind: left ? "continue" : "finished" };
      },
    });
    for (;;) {
      if (!left) break;
      let requests = 0;
      let handedOff = false;
      const advance = driver.advance;
      await runStepRunWorkflow(memoryDurableSteps().steps, {
        ...driver,
        advance: async () => {
          requests += 100;
          if (requests > 1_000)
            throw new Error("Synthetic invocation subrequest cap");
          return advance();
        },
        boundary: async (_name, force) => {
          if (force) handedOff = true;
          return Boolean(force);
        },
      });
      expect(left === 0 || handedOff).toBe(true);
    }
    expect(left).toBe(0);
  });
});
