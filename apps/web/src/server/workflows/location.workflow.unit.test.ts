import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  locationSearchWorkflow,
  makeTreeWorkflow,
  valuationSummaryWorkflow,
  subtreeWorkflow,
  inventoryBreakdownWorkflow,
  parentOptionsWorkflow,
  ensureGlobalUnknownWorkflow,
  bulkUpdateParentWorkflow,
  getByShortcodesWorkflow,
  recomputeValuationsWorkflow,
} from "./location.server";

describe("location workflow graphs", () => {
  it("registers all location application operations", () => {
    expect(
      [
        locationSearchWorkflow,
        makeTreeWorkflow,
        valuationSummaryWorkflow,
        subtreeWorkflow,
        inventoryBreakdownWorkflow,
        parentOptionsWorkflow,
        ensureGlobalUnknownWorkflow,
        bulkUpdateParentWorkflow,
        getByShortcodesWorkflow,
        recomputeValuationsWorkflow,
      ].map((workflow) => workflow.definition.name),
    ).toEqual([
      "location.search",
      "location.makeTree",
      "location.valuationSummary",
      "location.subtree",
      "location.inventoryBreakdown",
      "location.parentOptions",
      "location.ensureGlobalUnknown",
      "location.bulkUpdateParent",
      "location.getByShortcodes",
      "location.recomputeValuations",
    ]);
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
