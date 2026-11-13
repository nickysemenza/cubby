import { describe, expect, it } from "vitest";

import { decideField, type FieldInputs } from "./field-rules";

const proposal = {
  value: "CAT-B",
  label: "Category B",
  confidence: 0.9,
  runnerUp: { value: "CAT-C", label: "Category C", confidence: 0.1 },
};
const open: FieldInputs = {
  apply: "auto",
  fillOnly: false,
  current: null,
  currentUndecided: true,
  personHolds: false,
  vetoed: [],
  replaced: [],
  proposal,
};
const held: FieldInputs = {
  ...open,
  current: "CAT-A",
  currentUndecided: false,
};

describe("ADR 0028 field rules", () => {
  it.each<[string, FieldInputs, string]>([
    [
      "a person's value",
      { ...held, personHolds: true },
      "A person holds this value",
    ],
    ["no proposal", { ...open, proposal: null }, "Cubby proposed no value"],
    [
      "a vetoed proposal",
      { ...open, vetoed: ["CAT-B"] },
      "A person ruled this value out",
    ],
    [
      "an offer field",
      { ...open, apply: "offer" },
      "Cubby's answer waits in the picker",
    ],
    [
      "a below-bar answer",
      { ...open, proposal: { ...proposal, confidence: 0.8 } },
      "Cubby is not confident enough to act",
    ],
    [
      "a filled fillOnly field",
      { ...held, fillOnly: true },
      "Other records inherit this field; Cubby only fills it",
    ],
    [
      "a narrow replacement",
      {
        ...held,
        proposal: {
          ...proposal,
          runnerUp: { ...proposal.runnerUp, confidence: 0.75 },
        },
      },
      "A replacement must clearly beat the runner-up",
    ],
    [
      "a value it replaced before",
      { ...held, replaced: ["CAT-B"] },
      "This field already held that value once",
    ],
  ])("keeps the stored value for %s", (_name, input, reason) => {
    expect(decideField(input)).toEqual({ kind: "keep", reason });
  });

  it("fills an open field and revises its own value", () => {
    expect(decideField(open)).toMatchObject({ kind: "write", value: "CAT-B" });
    expect(decideField(held)).toMatchObject({ kind: "write", value: "CAT-B" });
  });

  it("offers a review field's confident answer to a member", () => {
    expect(decideField({ ...open, apply: "review" })).toEqual({
      kind: "review",
      proposal,
    });
  });

  it("clears a ruled-out value it cannot replace", () => {
    expect(
      decideField({
        ...held,
        vetoed: ["CAT-A"],
        proposal: { ...proposal, confidence: 0.5 },
      }),
    ).toMatchObject({ kind: "write", value: null });
    expect(decideField({ ...held, vetoed: ["CAT-A"] })).toMatchObject({
      kind: "write",
      value: "CAT-B",
    });
  });
});
