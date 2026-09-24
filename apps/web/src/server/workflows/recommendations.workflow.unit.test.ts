import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import { dismissDuplicateProductRecommendationWorkflow } from "./recommendations.server";

describe("recommendation workflow graphs", () => {
  it("commits duplicate recommendation dismissal after its reads", () => {
    expect(
      inspectWorkflow(
        dismissDuplicateProductRecommendationWorkflow.definition,
      ).steps.map((step) => step.type),
    ).toEqual(["parallel", "call", "committedCall"]);
  });
});
