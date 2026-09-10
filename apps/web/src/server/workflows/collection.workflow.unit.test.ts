import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  listCollectionSummaries,
  readCollectionDetail,
  readCollectionMatrix,
} from "./collection";

describe("collection workflow graphs", () => {
  it("registers collection reads", () => {
    expect(inspectWorkflow(listCollectionSummaries.definition).name).toBe(
      "collection.list",
    );
    expect(
      inspectWorkflow(readCollectionDetail.definition).steps.map(
        (step) => step.name,
      ),
    ).toEqual(["read"]);
    expect(inspectWorkflow(readCollectionMatrix.definition).name).toBe(
      "collection.matrix",
    );
  });
});
