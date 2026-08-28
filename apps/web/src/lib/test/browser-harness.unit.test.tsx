import { describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "./browser-harness";

describe("browser test harness", () => {
  it("binds real descriptor transports without shared state and restores its clock", async () => {
    const harness = createBrowserTestHarness({
      clock: { now: new Date("2026-08-28T12:00:00.000Z") },
    });
    const descriptor = {
      withTransport: (transport: (value: string) => string) => ({
        call: transport,
      }),
    };

    const bound = harness.operationAdapter.bind(descriptor, (value: string) =>
      value.toUpperCase(),
    );

    expect(bound.call("fresh")).toBe("FRESH");
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
});
