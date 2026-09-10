import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  dismissDuplicateProductRecommendationWorkflow,
  dismissTagPropagationWorkflow,
  dismissProductRecommendationWorkflow,
  getDuplicateProductRecommendationWorkflow,
} from "./recommendations.server";

describe("recommendation workflow graphs", () => {
  it("registers duplicate recommendation reads and resolution", () => {
    expect(
      inspectWorkflow(
        dismissDuplicateProductRecommendationWorkflow.definition,
      ).steps.map((step) => step.type),
    ).toEqual(["parallel", "call", "committedCall"]);
    expect(
      inspectWorkflow(
        getDuplicateProductRecommendationWorkflow.definition,
      ).steps.map((step) => step.name),
    ).toEqual(["find", "resolve"]);
    expect(
      inspectWorkflow(dismissTagPropagationWorkflow.definition).steps.map(
        (step) => step.name,
      ),
    ).toEqual(["read", "dismiss"]);
    expect(
      inspectWorkflow(
        dismissProductRecommendationWorkflow.definition,
      ).steps.map((step) => step.name),
    ).toEqual(["read", "dismiss"]);
  });
});
