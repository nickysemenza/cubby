import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  findSimilarEntitiesWorkflow,
  requestEmbeddingRefreshWorkflow,
} from "./search.server";

describe("search maintenance workflow graphs", () => {
  it("gates similarity candidates and hydration on embedding readiness", () => {
    const definition = findSimilarEntitiesWorkflow.definition;
    expect(
      inspectWorkflow(definition).steps.map((step) => [step.name, step.type]),
    ).toEqual([
      ["pair", "call"],
      ["source", "call"],
      ["readiness", "call"],
      ["matches", "branch"],
    ]);
    const branch = definition.steps.at(-1);
    if (branch?.type !== "branch") throw new Error("Missing readiness branch");
    expect(inspectWorkflow(branch.whenFalse).steps).toEqual([]);
    expect(
      inspectWorkflow(branch.whenTrue).steps.map((step) => step.name),
    ).toEqual(["candidates", "hits"]);
  });
  it("publishes an explicit refresh as one committed step after resolving the id", () => {
    expect(
      inspectWorkflow(requestEmbeddingRefreshWorkflow.definition).steps.map(
        (step) => [step.name, step.type],
      ),
    ).toEqual([
      ["resolve", "call"],
      ["publish", "committedCall"],
    ]);
  });
});
