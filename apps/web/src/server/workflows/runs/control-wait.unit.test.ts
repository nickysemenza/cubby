import { fromPartial } from "@total-typescript/shoehorn";
import type { WorkflowStep } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { memoryDurableSteps } from "~/server/testing/durable-steps";

import { waitForWorkflowControl, workflowControlWait } from "./control-wait";

describe("durable control waits", () => {
  it("continues before repeated discovery waits exhaust durable steps", async () => {
    const durable = memoryDurableSteps();
    let now = 1_000;
    let events = 0;
    let handedOff = false;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const step = fromPartial<WorkflowStep>({
      do: durable.steps.do,
      waitForEvent: async () => {
        now += ++events % 31 === 0 ? 45_000 : 500;
        return fromPartial({});
      },
    });
    try {
      const wait = workflowControlWait(step, async (name, force) => {
        await durable.steps.do(
          name,
          { retries: { limit: 0, delay: "1 second", backoff: "constant" } },
          async () => Boolean(force),
        );
        return Boolean(force);
      });
      for (let page = 0; page < 128; page++) {
        if (await wait(`synthetic-discovery:${page}`, now + 60_000)) {
          handedOff = true;
          break;
        }
      }
      expect(handedOff).toBe(true);
      expect(durable.completed.size + events).toBeLessThan(10_000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // An unrelated early event cannot bypass a retained admission/retry deadline.
  it("rechecks activation on buffered events and retains the original due time", async () => {
    const durable = memoryDurableSteps();
    let now = 1_000;
    const events: number[] = [];
    const check = vi.fn(async () => false);
    const waitForEvent = vi.fn(async (_name: string, timeoutMs: number) => {
      events.push(timeoutMs);
      now += events.length === 1 ? 1_000 : timeoutMs;
    });
    expect(
      await waitForWorkflowControl(durable.steps, {
        name: "synthetic-capacity",
        dueAt: 16_000,
        now: () => now,
        waitForEvent,
        boundary: check,
      }),
    ).toBe(false);
    expect(events).toEqual([15_000, 14_000]);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("continues through a fresh instance after a bounded burst of unrelated buffered events", async () => {
    const durable = memoryDurableSteps();
    let hints = 0;
    const waitForEvent = vi.fn(async () => {
      if (++hints > 32) throw new Error("Synthetic unbounded hint drain");
    });
    const boundary = vi.fn(async (_name: string, force?: boolean) =>
      Boolean(force),
    );
    expect(
      await waitForWorkflowControl(durable.steps, {
        name: "synthetic-buffered-hints",
        dueAt: Date.now() + 3_600_000,
        waitForEvent,
        boundary,
      }),
    ).toBe(true);
    expect(waitForEvent).toHaveBeenCalledTimes(32);
    expect(boundary.mock.calls.at(-1)?.[1]).toBe(true);
  });

  it("hands off immediately when an activation event interrupts a long wait", async () => {
    const durable = memoryDurableSteps();
    expect(
      await waitForWorkflowControl(durable.steps, {
        name: "synthetic-retry",
        dueAt: Date.now() + 3_600_000,
        waitForEvent: async () => {},
        boundary: async () => true,
      }),
    ).toBe(true);
    expect(durable.sleeps).toEqual([]);
  });
});
