import { describe, expect, it } from "vitest";

import { entityTimeline } from "~/integrations/tanstack-query/generated/entity-timeline.gen";
import { startOperation } from "~/integrations/tanstack-query/start-transport";

import { createBrowserTestHarness } from "./browser-harness";

describe("browser test harness", () => {
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
