import { describe, expect, it, vi } from "vitest";

import { entityTimeline } from "~/entities/entity-timeline.functions";
import { startOperation } from "~/integrations/tanstack-query/start-transport";

import { createBrowserTestHarness } from "./browser-harness";

describe("browser test harness", () => {
  it("pins and restores its clock", async () => {
    const harness = createBrowserTestHarness({
      clock: { now: new Date("2026-08-28T12:00:00.000Z") },
    });
    expect(harness.clock?.now()).toBe(
      new Date("2026-08-28T12:00:00.000Z").getTime(),
    );
    await harness.clock?.advanceBy(250);
    expect(harness.clock?.now()).toBe(
      new Date("2026-08-28T12:00:00.250Z").getTime(),
    );

    harness.dispose();
    expect(vi.isFakeTimers()).toBe(false);
  });

  // Regression: unmocked slot reads reached the real Start dispatcher and
  // rejected ~1s later, after the file's worker had torn down.
  it("rejects an operation with no injected transport inside the test", async () => {
    const harness = createBrowserTestHarness();
    const operation = startOperation({
      operation: entityTimeline.timeline.id,
      parse: (value) => value,
    });

    await expect(operation.call({})).rejects.toThrow(
      /reached the Start transport in a browser test/u,
    );
    harness.dispose();
  });
});
