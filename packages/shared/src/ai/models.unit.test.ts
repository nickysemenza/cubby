import { describe, expect, it } from "vitest";

import { CLEF_MODEL, DECISION_MODEL, selectDecisionModel } from "./models";

describe("selectDecisionModel", () => {
  it("maps one input to one model so its cached answer is reused", () => {
    const key = JSON.stringify(["field-suggestion", "v1", { name: "Oats" }]);
    const first = selectDecisionModel({ key });
    for (let call = 0; call < 50; call += 1)
      expect(selectDecisionModel({ key })).toBe(first);
  });

  it("keeps the configured share across distinct inputs", () => {
    const total = 4000;
    let clef = 0;
    for (let index = 0; index < total; index += 1) {
      const model = selectDecisionModel({
        key: JSON.stringify([
          "field-suggestion",
          "v1",
          { name: `Row ${index}` },
        ]),
      });
      expect([DECISION_MODEL, CLEF_MODEL]).toContain(model);
      if (model === CLEF_MODEL) clef += 1;
    }
    expect(clef / total).toBeGreaterThan(0.45);
    expect(clef / total).toBeLessThan(0.55);
  });

  it("routes image decisions to the vision model regardless of key", () => {
    expect(selectDecisionModel({ vision: true, key: "any" })).toBe(CLEF_MODEL);
  });
});
