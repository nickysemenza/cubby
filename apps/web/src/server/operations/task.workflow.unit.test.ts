import { describe, expect, it } from "vitest";

import { taskBulkReorderWorkflow } from "./task.server";

describe("task workflow definitions", () => {
  it("runs reorder effects only after the domain mutation", () => {
    expect(
      taskBulkReorderWorkflow.definition.steps.map((step) => step.type),
    ).toEqual(["committedCall", "committedEffect", "committedEffect"]);
  });
});
