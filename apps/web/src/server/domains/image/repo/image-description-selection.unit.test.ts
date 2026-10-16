import { selectImageDescriptionEvidence } from "@cubby/schemas/image-processing";
import { expect, it } from "vitest";

// Claims must come from the same current-source analysis as the selected prose.
it("keeps claims with their authority and never lends model claims to member prose", () => {
  const analysis = {
    analysisId: crypto.randomUUID(),
    provider: "synthetic",
    model: "synthetic-model",
    createdAt: "2026-10-01T00:00:00.000Z",
    preferred: true,
    inputFingerprint: JSON.stringify({ sourceContentHash: "current" }),
    result: {
      description: "Synthetic red boot",
      claims: [{ text: "Red", evidenceKind: "visual" as const }],
      cutoutEligibility: "review" as const,
    },
  };
  expect(
    selectImageDescriptionEvidence([analysis], null, "current"),
  ).toMatchObject({
    authority: "model",
    claims: analysis.result.claims,
    analysis: { id: analysis.analysisId },
  });
  expect(
    selectImageDescriptionEvidence(
      [analysis],
      { description: "Synthetic blue boot" },
      "current",
    ),
  ).toMatchObject({
    authority: "member",
    description: "Synthetic blue boot",
    analysis: null,
    claims: [],
  });
  expect(
    selectImageDescriptionEvidence([analysis], null, "changed"),
  ).toMatchObject({
    authority: "missing",
    claims: [],
    missingReason: expect.any(String),
  });
});
