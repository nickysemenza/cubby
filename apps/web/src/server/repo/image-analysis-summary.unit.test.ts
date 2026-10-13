import { imageAnalysisSummarySchema } from "@cubby/schemas/image";
import { imageIdentificationResult } from "@cubby/schemas/image-identification";
import { describe, expect, it } from "vitest";

import { composeImageAnalysisSummary } from "./image-analysis-summary";

describe("image analysis summary", () => {
  // Identification is useful before either description pipeline has run, including abstentions.
  it("retains identification-only evidence through the MCP summary schema", () => {
    const identification = imageIdentificationResult.parse({
      subject: "multiple_objects",
      category: null,
      outcome: "not_single_identity",
      candidates: [],
      considered: 0,
      truncated: false,
    });
    const summary = composeImageAnalysisSummary(
      undefined,
      undefined,
      identification,
    );
    expect(summary).toEqual({
      description: null,
      classifications: [],
      recognizedText: null,
      identification,
    });
    expect(imageAnalysisSummarySchema.parse(summary).identification).toEqual(
      identification,
    );
  });

  it("does not expose identification rejected by the retained reader while keeping other analysis", () => {
    expect(composeImageAnalysisSummary(undefined, undefined)).toBeNull();
    const summary = composeImageAnalysisSummary(
      {
        classifications: [{ identifier: "Synthetic tool", confidence: 0.9 }],
        recognizedText: [{ text: "SYNTHETIC", confidence: 0.8 }],
      },
      undefined,
    );
    expect(summary).toEqual({
      description: null,
      classifications: ["Synthetic tool"],
      recognizedText: "SYNTHETIC",
    });
    expect(summary?.identification).toBeUndefined();
  });
});
