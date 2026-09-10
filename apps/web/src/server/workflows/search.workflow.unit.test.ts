import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  enqueueEmbeddingBackfillWorkflow,
  findSimilarEntitiesWorkflow,
  repairSearchDocumentsWorkflow,
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
  it("keeps durable maintenance operations as committed steps", () => {
    expect(
      inspectWorkflow(repairSearchDocumentsWorkflow.definition).steps.map(
        (step) => step.type,
      ),
    ).toEqual(["committedCall"]);
    expect(
      inspectWorkflow(enqueueEmbeddingBackfillWorkflow.definition).steps.map(
        (step) => step.type,
      ),
    ).toEqual(["committedCall"]);
  });
});
