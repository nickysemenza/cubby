import { describe, expect, it } from "vitest";

import { decideAutomaticField, type AutomaticFieldInput } from "./field-policy";

const base: AutomaticFieldInput = {
  entity: "product",
  field: "category",
  eligible: true,
  saved: true,
  provenanceCurrent: true,
  subjectExists: true,
  hasEvidence: true,
  holder: "open",
  explicitNone: false,
  currentAvailable: true,
  effectiveEmpty: true,
  fillOnly: false,
  confidence: 0.9,
  runnerUpConfidence: 0.1,
  rejected: false,
  replaced: false,
};

describe("automatic field policy", () => {
  it.each<[Partial<AutomaticFieldInput>, string]>([
    [
      { eligible: false },
      "Field product.category is not eligible for automatic fill",
    ],
    [{ saved: false }, "Only a saved field suggestion can apply automatically"],
    [
      { provenanceCurrent: false },
      "Automatic fill requires current complete AI policy provenance",
    ],
    [{ subjectExists: false }, "Automatic fill subject no longer exists"],
    [
      { hasEvidence: false },
      "Automatic fill requires supporting field evidence",
    ],
    [{ holder: "person" }, "Automatic fill preserves a person's value"],
    [
      { explicitNone: true },
      "Automatic fill preserves an existing field decision",
    ],
    [
      { currentAvailable: false },
      "Automatic fill requires an available current field result",
    ],
    [
      { effectiveEmpty: false },
      "Automatic fill preserves populated effective values",
    ],
    [
      { holder: "cubby", effectiveEmpty: false, fillOnly: true },
      "Other records inherit this field; Cubby only fills it",
    ],
    [
      {
        holder: "cubby",
        effectiveEmpty: false,
        confidence: 0.9,
        runnerUpConfidence: 0.8,
      },
      "A replacement must clearly beat Cubby's current value",
    ],
    [{ rejected: true }, "Automatic fill preserves a rejected value"],
    [
      { holder: "cubby", replaced: true },
      "Cubby already replaced this value once",
    ],
  ])("refuses %o", (change, reason) => {
    expect(decideAutomaticField({ ...base, ...change })).toEqual({
      kind: "refuse",
      reason,
    });
  });
  it("applies eligible open and Cubby-held values", () => {
    expect(decideAutomaticField(base)).toEqual({ kind: "apply" });
    expect(
      decideAutomaticField({ ...base, holder: "cubby", effectiveEmpty: false }),
    ).toEqual({ kind: "apply" });
  });
  it("preserves refusal precedence", () => {
    expect(
      decideAutomaticField({
        ...base,
        rejected: true,
        holder: "cubby",
        replaced: true,
      }),
    ).toEqual({
      kind: "refuse",
      reason: "Automatic fill preserves a rejected value",
    });
  });
});
