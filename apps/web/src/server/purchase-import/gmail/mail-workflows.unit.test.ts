/**
 * The step sequence of the two Gmail Workflows, under an in-memory step with
 * Cloudflare's replay and retry semantics. The step bodies themselves are
 * PostgreSQL-tested; this covers what only the orchestration decides:
 *
 * - a rate-limited page sleeps its `Retry-After` under a new step name rather
 *   than replaying the cached rate-limit result, and gives up after a bound;
 * - a step that keeps failing is retried, then fails the Run once and leaves
 *   the instance errored;
 * - a cancelled or superseded attempt stops without failing the Run;
 * - an interrupted execution replays completed steps from their saved
 *   results instead of running them again (a deploy mid-run).
 */
import { describe, expect, it, vi } from "vitest";

import { memoryDurableSteps } from "~/server/testing/durable-steps";

import {
  MAX_RATE_LIMIT_WAITS,
  runMailDiscovery,
  runVendorMailSearch,
  type MailDiscoveryWork,
  type VendorMailSearchWork,
} from "./mail-workflows";

const vendorWork = (
  overrides: Partial<VendorMailSearchWork> = {},
): VendorMailSearchWork => ({
  begin: vi.fn(async () => ({ kind: "page" as const, page: 0 })),
  scanPage: vi.fn(async (page: number) =>
    page < 2
      ? { kind: "more" as const, nextPage: page + 1 }
      : { kind: "done" as const },
  ),
  fail: vi.fn(async () => null),
  ...overrides,
});

describe("vendor mail search Workflow", () => {
  it("walks pages under stable names until the last one", async () => {
    const { steps, attempts } = memoryDurableSteps();
    const work = vendorWork();

    await runVendorMailSearch(steps, work);

    expect(attempts).toEqual([
      "begin#1",
      "page.0.scan.0#1",
      "page.1.scan.0#1",
      "page.2.scan.0#1",
    ]);
    expect(work.fail).not.toHaveBeenCalled();
  });

  it("sleeps a rate limit's wait and rescans the same page under a new name", async () => {
    const { steps, attempts, sleeps } = memoryDurableSteps();
    let limited = true;
    const work = vendorWork({
      begin: async () => ({ kind: "page", page: 3 }),
      scanPage: async () => {
        if (!limited) return { kind: "done" };
        limited = false;
        return { kind: "rate_limited", retryAfterMs: 45_000 };
      },
    });

    await runVendorMailSearch(steps, work);

    expect(sleeps).toEqual([{ name: "page.3.wait.0", durationMs: 45_000 }]);
    expect(attempts).toEqual(["begin#1", "page.3.scan.0#1", "page.3.scan.1#1"]);
  });

  it("fails the Run after a bounded number of rate-limit waits", async () => {
    const { steps, sleeps } = memoryDurableSteps();
    const work = vendorWork({
      scanPage: async () => ({ kind: "rate_limited", retryAfterMs: 1000 }),
    });

    await expect(runVendorMailSearch(steps, work)).rejects.toThrow(
      /rate limited Gmail page 1/u,
    );
    expect(sleeps).toHaveLength(MAX_RATE_LIMIT_WAITS - 1);
    expect(work.fail).toHaveBeenCalledTimes(1);
  });

  it("retries a failing page, then fails the Run once and errors the instance", async () => {
    const { steps, attempts } = memoryDurableSteps();
    const work = vendorWork({
      scanPage: async () => {
        throw new Error("Synthetic Gmail outage");
      },
    });

    await expect(runVendorMailSearch(steps, work)).rejects.toThrow(
      "Synthetic Gmail outage",
    );
    expect(attempts.filter((name) => name.startsWith("page.0.scan.0"))).toEqual(
      [
        "page.0.scan.0#1",
        "page.0.scan.0#2",
        "page.0.scan.0#3",
        "page.0.scan.0#4",
      ],
    );
    expect(work.fail).toHaveBeenCalledExactlyOnceWith("Synthetic Gmail outage");
  });

  it("stops a cancelled attempt without failing the Run", async () => {
    const { steps } = memoryDurableSteps();
    const work = vendorWork({
      scanPage: async () => ({ kind: "stopped" }),
    });

    await runVendorMailSearch(steps, work);

    expect(work.fail).not.toHaveBeenCalled();
  });

  it("replays completed pages from saved results after an interruption", async () => {
    const first = memoryDurableSteps();
    let crash = true;
    const interrupted = vendorWork({
      scanPage: async (page) => {
        if (page === 1 && crash) throw new Error("isolate evicted");
        return page < 2
          ? { kind: "more", nextPage: page + 1 }
          : { kind: "done" };
      },
    });
    await expect(
      runVendorMailSearch(
        {
          ...first.steps,
          // An eviction ends the execution; it is not a step failure.
          do: (name, config, callback) =>
            name === "fail"
              ? Promise.reject(new Error("evicted"))
              : first.steps.do(
                  name,
                  { retries: { ...config.retries, limit: 0 } },
                  callback,
                ),
        },
        interrupted,
      ),
    ).rejects.toThrow("evicted");

    crash = false;
    const replay = memoryDurableSteps(
      new Map([...first.completed].filter(([name]) => name !== "fail")),
    );
    const resumed = vendorWork({ scanPage: interrupted.scanPage });
    await runVendorMailSearch(replay.steps, resumed);

    expect(replay.attempts).toEqual(["page.1.scan.0#1", "page.2.scan.0#1"]);
    expect(resumed.begin).not.toHaveBeenCalled();
  });
});

const discoveryWork = (
  overrides: Partial<MailDiscoveryWork> = {},
): MailDiscoveryWork => ({
  begin: vi.fn(async () => ({ kind: "page" as const, index: 0 })),
  list: vi.fn(async (page: number) => ({
    kind: "listed" as const,
    more: page < 2,
  })),
  batch: vi.fn(async () => ({ kind: "done" as const })),
  finish: vi.fn(async () => ({ kind: "done" as const })),
  continue: vi.fn(async () => undefined),
  fail: vi.fn(async () => null),
  ...overrides,
});

describe("mail discovery Workflow", () => {
  it("checkpoints a bounded page before listing the next one, then finishes", async () => {
    const { steps, attempts } = memoryDurableSteps();
    const work = discoveryWork();

    await runMailDiscovery(steps, work);

    expect(attempts).toEqual([
      "begin#1",
      "page.0.list#1",
      "page.0.save#1",
      "page.1.list#1",
      "page.1.save#1",
      "page.2.list#1",
      "page.2.save#1",
      "finish#1",
      "continue#1",
    ]);
  });

  it("fails the Run when a batch keeps failing, without finishing", async () => {
    const { steps } = memoryDurableSteps();
    const work = discoveryWork({
      batch: async (index) => {
        if (index === 1) throw new Error("Synthetic storage outage");
        return { kind: "done" };
      },
    });

    await expect(runMailDiscovery(steps, work)).rejects.toThrow(
      "Synthetic storage outage",
    );
    expect(work.finish).not.toHaveBeenCalled();
    expect(work.fail).toHaveBeenCalledExactlyOnceWith(
      "Synthetic storage outage",
    );
  });

  it("stops when the Run was cancelled mid-pass", async () => {
    const { steps } = memoryDurableSteps();
    const work = discoveryWork({ batch: async () => ({ kind: "stopped" }) });

    await runMailDiscovery(steps, work);

    expect(work.finish).not.toHaveBeenCalled();
    expect(work.fail).not.toHaveBeenCalled();
  });
});
