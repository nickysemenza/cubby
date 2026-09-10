import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import { fetchVendorLogoWorkflow, mergeVendorsWorkflow } from "./vendor.server";

describe("vendor workflow graphs", () => {
  it("registers committed vendor mutations and committed effects", () => {
    expect(inspectWorkflow(mergeVendorsWorkflow.definition).steps).toEqual([
      expect.objectContaining({ name: "merge", type: "committedCall" }),
    ]);
    expect(inspectWorkflow(fetchVendorLogoWorkflow.definition).steps).toEqual([
      expect.objectContaining({ name: "fetch", type: "committedCall" }),
      expect.objectContaining({ name: "effects", type: "committedEffect" }),
    ]);
  });
});
