import { describe, expect, it } from "vitest";

import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import * as products from "./product.server";

describe("product workflow ownership", () => {
  it("registers each non-streaming export under its public operation identity", () => {
    for (const [name, operation] of Object.entries(products)) {
      if (name === "productSearchInput") continue;
      if (!("definition" in operation))
        throw new Error(`${name} has no executable definition`);
      expect(
        startOperationDefinitionFor(operation.definition.name),
      ).toBeDefined();
    }
  });

  it("keeps UPC image selection, bounded imports, and summary declarative", () => {
    const definition = products.backfillProductUpcImagesWorkflow.definition;
    expect(definition).toMatchObject({
      kind: "bulk",
      name: "product.backfillUPCImages",
      concurrency: 10,
      progressCadence: "window",
      onItemError: "stop",
    });
    expect(
      inspectWorkflow(definition.items).steps.map((step) => step.name),
    ).toEqual(["candidates"]);
    expect(inspectWorkflow(definition.item).steps).toMatchObject([
      { type: "committedCall", name: "result" },
    ]);
  });
});
