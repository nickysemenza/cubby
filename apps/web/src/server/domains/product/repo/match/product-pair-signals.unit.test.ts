import { describe, expect, it } from "vitest";

import { readStoredProductPair } from "./product-pair-signals";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const literal = (productId: string, value: string) => ({
  productId,
  sourceId: productId === A ? A : B,
  field: "name" as const,
  valueFingerprint: "synthetic",
  quote: `Synthetic ${value} scarf`,
  start: 10,
  end: 10 + value.length,
  value,
  binding: "unambiguous" as const,
  selectedVariant: null,
});
const stored = {
  evidence: "Synthetic stored conflict",
  signals: {
    snapshots: [
      { id: A, verifiedModel: "SYN-A" },
      { id: B, verifiedModel: "SYN-B" },
    ],
    variantEvidence: {
      producer: {
        kind: "model",
        model: "synthetic/model",
        revision: "synthetic",
        runId: null,
        evaluationId: null,
      },
      inputFingerprint: "synthetic",
      priorConflictIds: [],
      dependencies: [],
      dimensions: [
        {
          dimension: "color",
          first: literal(A, "blue"),
          second: literal(B, "red"),
          relation: "different",
          decisions: [],
        },
        {
          dimension: "size",
          first: null,
          second: null,
          relation: "unknown",
          decisions: [],
        },
        {
          dimension: "pack",
          first: null,
          second: null,
          relation: "unknown",
          decisions: [],
        },
      ],
    },
  },
};

// The keeper may be the canonical B side (a purchase-role Product); its values
// must lead, or the card reads "Keep: red" for a blue keeper.
describe("readStoredProductPair", () => {
  it("shows current model contradictions without calling their text verified", () => {
    expect(
      readStoredProductPair(
        {
          signals: {
            snapshots: [
              { id: A, model: "SYN-A" },
              { id: B, model: "SYN-B" },
            ],
          },
        },
        B,
      ).conflictReasons,
    ).toEqual(['Model: "SYN-B" vs "SYN-A"']);
  });
  it("orders conflict values from the keeper's side", () => {
    expect(readStoredProductPair(stored, A).conflictReasons).toEqual([
      'Verified model: "SYN-A" vs "SYN-B"',
      'Color: "blue" vs "red"',
    ]);
    expect(readStoredProductPair(stored, B).conflictReasons).toEqual([
      'Verified model: "SYN-B" vs "SYN-A"',
      'Color: "red" vs "blue"',
    ]);
  });
});
