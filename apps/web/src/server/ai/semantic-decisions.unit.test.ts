import { runEntityId } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";

import type { DecisionPort } from "./decision-model";
import { withAiInputs } from "./evaluation-inputs";
import { IMAGE_PROVENANCE_CLASSIFICATION_FEATURE } from "./policy/features";
import {
  decideImageProvenanceWithEvidence,
  decideProductVariantComparison,
  decideProductVariantComparisons,
  decideUpcOfferComparability,
} from "./semantic-decisions";

const usage = {
  db: {} as Database,
  runId: runEntityId.parse("00000000-0000-4000-8000-000000000001"),
  operation: "semantic-decision-test",
};

const portFor = (choiceIndex: number, probability: number): DecisionPort =>
  vi.fn<DecisionPort>(async (input) => {
    const keys = Object.keys(input.questions.selection.criteria);
    const choice = `c${choiceIndex}`;
    const remainder = (1 - probability) / (keys.length - 1);
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence: probability,
          probabilities: Object.fromEntries(
            keys.map((key) => [key, key === choice ? probability : remainder]),
          ),
        },
      },
    };
  });

describe("semantic decision adapters", () => {
  it("keeps singleton and batch routing identical for the same complete pair", async () => {
    const pair = {
      firstTitle: "Synthetic red hat",
      secondTitle: "Synthetic blue hat",
    };
    const single = await withAiInputs(true, () =>
      decideProductVariantComparison({ ...pair, usage }),
    );
    const batch = await withAiInputs(true, () =>
      decideProductVariantComparisons({ comparisons: [pair], usage }),
    );
    expect(single.inputs).toHaveLength(1);
    expect(batch.inputs).toEqual(single.inputs);
  });

  it("records the injected port's actual model in image provenance", async () => {
    const result = await decideImageProvenanceWithEvidence({
      input: {
        filename: "synthetic.png",
        width: 100,
        height: 100,
        sourceAssetUrl: null,
        sourcePageUrl: null,
        sourceName: null,
        sightingSourceTypes: [],
        hasExifCamera: false,
        hasExifCaptureTime: false,
        analysisSummary: null,
      },
      usage,
      port: portFor(0, 0.95),
    });
    expect(result.model).toBe(IMAGE_PROVENANCE_CLASSIFICATION_FEATURE.model);
  });
  it("maps closed choices to their typed variant relations", async () => {
    const result = await decideProductVariantComparison({
      firstTitle: "Synthetic boots, size 7",
      secondTitle: "Synthetic boots, size 9",
      usage,
      port: portFor(4, 0.95),
    });

    expect(result).toEqual({
      color: { relation: "different" },
      size: { relation: "different" },
      evidence: {
        firstTitle: "Synthetic boots, size 7",
        secondTitle: "Synthetic boots, size 9",
      },
    });
  });

  it("keeps batch positions and full evidence when an intervening pair abstains", async () => {
    const port = portFor(0, 0.95);
    const comparisons = [
      {
        firstTitle: "Synthetic blue shirt, M",
        secondTitle: "Synthetic blue shirt, M",
      },
      {
        firstTitle: "x".repeat(4_001),
        secondTitle: "Synthetic bounded source",
      },
      {
        firstTitle: "Synthetic red hat, L",
        secondTitle: "Synthetic red hat, L",
      },
    ];
    const results = await decideProductVariantComparisons({
      comparisons,
      usage,
      port,
    });
    expect(results.map((result) => result.evidence)).toEqual(comparisons);
    expect(results.map((result) => result.color.relation)).toEqual([
      "same",
      "unknown",
      "same",
    ]);
    expect(port).toHaveBeenCalledTimes(2);
  });

  it("turns a medium-confidence offer choice into visible unknown", async () => {
    const result = await decideUpcOfferComparability({
      itemTitle: "Sample canister, 500 g",
      offerTitle: "Sample canister assortment",
      usage,
      port: portFor(0, 0.7),
    });

    expect(result).toBe("unknown");
  });

  it("propagates malformed or unavailable model responses to the caller", async () => {
    const port: DecisionPort = vi.fn(async () => {
      throw new Error("decision gateway unavailable");
    });

    await expect(
      decideUpcOfferComparability({
        itemTitle: "Sample item",
        offerTitle: "Sample offer",
        usage,
        port,
      }),
    ).rejects.toThrow("decision gateway unavailable");
  });

  // Stable name + identifier evidence can exceed the old 500-character skip.
  it("checks full stable variant evidence above 500 characters", async () => {
    const port = portFor(0, 0.99);
    const results = await decideProductVariantComparisons({
      comparisons: [
        {
          firstTitle: `Synthetic boot ${"ABC123 ".repeat(80)}`,
          secondTitle: "Synthetic boot",
        },
      ],
      usage,
      port,
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(results[0]?.color.relation).toBe("same");
  });

  it("abstains before model invocation when bounded source text is truncated", async () => {
    const port = portFor(0, 0.99);
    const result = await decideProductVariantComparison({
      firstTitle: "x".repeat(4_001),
      secondTitle: "Synthetic product",
      usage,
      port,
    });

    expect(result.color.relation).toBe("unknown");
    expect(result.size.relation).toBe("unknown");
    expect(port).not.toHaveBeenCalled();
  });
});
