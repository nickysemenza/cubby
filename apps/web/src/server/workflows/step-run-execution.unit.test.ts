import { WORKFLOW_EXECUTION_LIMITS } from "@cubby/shared/workflow-limits";
import { describe, expect, it, vi } from "vitest";

import { memoryDurableSteps } from "~/server/testing/durable-steps";

import { runStepRunWorkflow, type StepRunWork } from "./step-run-execution";

const work = (overrides: Partial<StepRunWork> = {}): StepRunWork => {
  let page = 0;
  return {
    inspect: async () => ({
      name: `synthetic p${++page}`,
      scope: "synthetic",
      nextInstanceId: "RUN-4K7M-2",
      summary: null,
    }),
    advance: async () => ({ kind: "finished" }),
    boundary: async () => false,
    wait: async () => {},
    fail: async () => false,
    recover: async () => {},
    ...overrides,
  };
};

describe("step Run Workflow failure and invocation boundaries", () => {
  it("executes again after a deadline wait leaves the inspected checkpoint unchanged", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await runStepRunWorkflow(
      {
        ...memoryDurableSteps().steps,
        sleep: async (_name, duration) => {
          sleeps.push(duration);
        },
      },
      work({
        inspect: async () => ({
          name: "same checkpoint",
          scope: "synthetic",
          nextInstanceId: "RUN-4K7M-2",
          summary: null,
        }),
        advance: async () =>
          ++calls === 1
            ? { kind: "continue", waitSeconds: 60 }
            : { kind: "finished" },
        boundary: async (_name, force) => Boolean(force),
      }),
    );
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  // Cheap and partially filled label pages still use the driver's static budget.
  it("keeps cheap label pages in one instance beyond the former two-page cap", async () => {
    let advanced = 0;
    let handedOff = false;
    await runStepRunWorkflow(
      memoryDurableSteps().steps,
      work({
        inspect: async () =>
          advanced < 4
            ? {
                name: `labels p${advanced + 1}`,
                scope: "synthetic",
                nextInstanceId: "RUN-4K7M-2",
                summary: null,
              }
            : null,
        advance: async () => {
          advanced++;
          return {
            kind: "continue",
            execution: {
              phase: "labels",
              pagesPerInstance:
                WORKFLOW_EXECUTION_LIMITS.decisionPagesPerInstance,
            },
          };
        },
        boundary: async (_name, force) => {
          handedOff ||= Boolean(force);
          return Boolean(force);
        },
      }),
    );
    expect(advanced).toBe(4);
    expect(handedOff).toBe(false);
  });

  // Cheap database pages must not spend a model-heavy page's whole share;
  // their work still reduces the same allowance across a phase transition.
  it("shares proportional page allowances across cheap and model-heavy phases", async () => {
    let advanced = 0;
    await runStepRunWorkflow(
      memoryDurableSteps().steps,
      work({
        advance: async () => {
          advanced++;
          return {
            kind: "continue",
            execution:
              advanced <= 5
                ? { phase: "database", pagesPerInstance: 100 }
                : { phase: "decisions", pagesPerInstance: 4 },
          };
        },
        boundary: async (_name, force) => Boolean(force),
      }),
    );
    expect(advanced).toBe(9);
  });

  // Changing phase must not replenish an instance's declared page allowance.
  it("rotates at a global page allowance across phase changes", async () => {
    let advanced = 0;
    let handedOff = false;
    await runStepRunWorkflow(
      memoryDurableSteps().steps,
      work({
        advance: async () => {
          advanced++;
          return {
            kind: "continue",
            execution: { phase: `phase-${advanced}`, pagesPerInstance: 3 },
          };
        },
        boundary: async (_name, force) => {
          handedOff ||= Boolean(force);
          return Boolean(force);
        },
      }),
    );
    expect(advanced).toBe(3);
    expect(handedOff).toBe(true);
  });

  // Different RunSteps may share a phase and position; one must never replay
  // the other's completed page instead of executing its own work.
  it("keeps identical phase/page labels in different durable scopes separate", async () => {
    const plans = ["first", "second"].map((scope) => ({
      name: "scan p1 · items 1–20",
      scope,
      nextInstanceId: "RUN-4K7M-2",
      summary: null,
    }));
    let advanced = 0;
    await runStepRunWorkflow(
      memoryDurableSteps().steps,
      work({
        inspect: async () => plans.shift() ?? null,
        advance: async () => {
          advanced++;
          return { kind: "continue" };
        },
      }),
    );
    expect(advanced).toBe(2);
  });
  // A dashboard page must describe its durable scope; replay must not rename it
  // from a later checkpoint or run the paid page again.
  it("memoizes page scope and retains compact page and handoff summaries", async () => {
    const durable = memoryDurableSteps();
    let inspected = 0;
    let advanced = 0;
    const summary = {
      phase: "generate",
      unit: "charges",
      pageProcessed: 20,
      pageFailures: 0,
      cumulative: { processed: 80, total: 200, failures: 0 },
      labels: { reused: 3, generated: 0 },
      cursor: { stepId: "00000000-0000-4000-8000-000000000002", page: 4 },
    };
    const driver = work({
      inspect: async () => {
        inspected++;
        return {
          name: "generate p4 · charges 61–80",
          scope: "statement_transaction",
          nextInstanceId: "RUN-4K7M-3",
          summary,
        };
      },
      advance: async () => {
        advanced++;
        return {
          kind: "continue",
          execution: { phase: "generate", pagesPerInstance: 1 },
          summary,
        };
      },
      boundary: async (_name, force, dashboard) => {
        if (force) {
          await durable.steps.do(
            `handoff → ${dashboard?.nextInstanceId}`,
            { retries: { limit: 0, delay: "1 second", backoff: "constant" } },
            async () => dashboard ?? null,
          );
        }
        return Boolean(force);
      },
    });
    await runStepRunWorkflow(durable.steps, driver);
    await runStepRunWorkflow(durable.steps, driver);
    expect(inspected).toBe(1);
    expect(advanced).toBe(1);
    expect(
      durable.completed.get(
        "generate p4 · charges 61–80 · statement_transaction · iteration 1",
      ),
    ).toMatchObject({
      summary,
    });
    expect(durable.completed.get("handoff → RUN-4K7M-3")).toMatchObject({
      nextInstanceId: "RUN-4K7M-3",
      summary,
    });
  });
  // A capacity deferral at the final page must not become an immediate successor retry.
  it("retains durable capacity backoff before a bounded handoff", async () => {
    const durable = memoryDurableSteps();
    let sleepsAtHandoff: typeof durable.sleeps = [];
    await runStepRunWorkflow(
      durable.steps,
      work({
        advance: async () => ({
          kind: "continue",
          execution: { phase: "labels", pagesPerInstance: 1 },
          waitSeconds: 60,
        }),
        boundary: async (_name, force) => {
          if (force) sleepsAtHandoff = [...durable.sleeps];
          return Boolean(force);
        },
      }),
    );
    expect(sleepsAtHandoff).toEqual([
      { name: "capacity:0", durationMs: 60_000 },
    ]);
  });
  // Wall time and durable waits do not spend an instance's resource allowance.
  // Deployment and resource fences still decide continuation independently.
  it("continues useful work beyond ten minutes without rotating the instance", async () => {
    let pages = 0;
    let forced = 0;
    vi.useFakeTimers();
    try {
      await runStepRunWorkflow(
        memoryDurableSteps().steps,
        work({
          advance: async () => {
            vi.setSystemTime(Date.now() + 3_600_000);
            return ++pages === 3
              ? { kind: "finished" }
              : {
                  kind: "continue",
                  execution: { phase: "generation", pagesPerInstance: 100 },
                };
          },
          boundary: async (_name, force) => {
            if (force) forced++;
            return Boolean(force);
          },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
    expect(pages).toBe(3);
    expect(forced).toBe(0);
  });

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
          if (requests > 4_000)
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
