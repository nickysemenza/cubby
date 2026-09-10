import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import * as products from "./product.server";

describe("product workflow ownership", () => {
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
