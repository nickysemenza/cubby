import { describe, expect, it } from "vitest";

import {
  attachFileWorkflow,
  createFileUploadWorkflow,
  cullPendingImagesWorkflow,
  importImageFromUrlWorkflow,
  initiateDocumentUploadWorkflow,
  initiateImageUploadWorkflow,
  markImageUploadedWorkflow,
} from "./image.server";

describe("image workflow commit ownership", () => {
  it("declares storage operations that write image rows as committed", () => {
    for (const workflow of [
      attachFileWorkflow,
      createFileUploadWorkflow,
      cullPendingImagesWorkflow,
      importImageFromUrlWorkflow,
      initiateDocumentUploadWorkflow,
      initiateImageUploadWorkflow,
    ]) {
      expect(workflow.definition.steps[0]).toMatchObject({
        type: "committedCall",
      });
    }
  });

  it("resolves the uploaded image before its committed update", () => {
    expect(markImageUploadedWorkflow.definition.steps).toMatchObject([
      { type: "call", name: "resolveImage" },
      { type: "committedCall", name: "markUploaded" },
      { type: "committedCall", name: "scheduleImageProcessing" },
    ]);
  });
});
