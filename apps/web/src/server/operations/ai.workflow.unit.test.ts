import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  backfillLocationDescriptionsWorkflow,
  precomputeEnrichmentProposalsWorkflow,
} from "./ai.server";

describe("AI workflow graphs", () => {
  it("keeps precompute bounded and parallel while echoing shortcodes", () => {
    const definition = precomputeEnrichmentProposalsWorkflow.definition;
    expect(definition.concurrency).toBe(5);
    expect(
      inspectWorkflow(definition.items).steps.map((step) => step.name),
    ).toEqual(["resolved"]);
    const item = inspectWorkflow(definition.item);
    expect(item.steps.map((step) => step.name)).toEqual(["lookups"]);
    expect(item.steps[0]).toMatchObject({
      type: "parallel",
      concurrency: 2,
      branches: { usda: { name: "usda" }, merge: { name: "merge" } },
    });
    expect(definition.onItemError).toBe("continue");
    expect(definition.errorProgress).toEqual(expect.any(Function));
  });

  it("keeps location-description selection and durable enqueue inspectable", () => {
    const definition = backfillLocationDescriptionsWorkflow.definition;
    expect(definition).toMatchObject({
      kind: "coordinator",
      name: "ai.backfillLocationDescriptions",
    });
    expect(
      inspectWorkflow(definition.select).steps.map((step) => step.name),
    ).toEqual(["locationIds"]);
    expect(inspectWorkflow(definition.commit).steps).toMatchObject([
      { type: "committedCall", name: "enqueued" },
    ]);
  });
});
