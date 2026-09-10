import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  ensureGlobalUnknownWorkflow,
  bulkUpdateParentWorkflow,
} from "./location.server";

describe("location workflow graphs", () => {
  it("keeps location mutations and effects in the declared order", () => {
    expect(
      inspectWorkflow(ensureGlobalUnknownWorkflow.definition).steps.map(
        ({ name, type }) => ({ name, type }),
      ),
    ).toEqual([
      { name: "location", type: "committedCall" },
      { name: "entityId", type: "committedEffect" },
      { name: "effects", type: "committedEffect" },
    ]);
    expect(
      inspectWorkflow(bulkUpdateParentWorkflow.definition).steps.map(
        ({ name, type }) => ({ name, type }),
      ),
    ).toEqual([
      { name: "values", type: "call" },
      { name: "reparent", type: "committedCall" },
    ]);
  });
});
