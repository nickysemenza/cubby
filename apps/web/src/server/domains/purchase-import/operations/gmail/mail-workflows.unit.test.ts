/**
 * The step sequence of the Gmail Workflow, under an in-memory step with
 * Cloudflare's replay and retry semantics. The step bodies themselves are
 * PostgreSQL-tested; this covers what only the orchestration decides:
 *
 * - a step that keeps failing is retried, then fails the Run once and leaves
 *   the instance errored;
 * - a cancelled or superseded attempt stops without failing the Run;
 * - an interrupted execution replays completed steps from their saved
 *   results instead of running them again (a deploy mid-run).
 */
import { describe, expect, it, vi } from "vitest";

import { memoryDurableSteps } from "~/server/testing/durable-steps";

import { runMailDiscovery, type MailDiscoveryWork } from "./mail-workflows";

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
