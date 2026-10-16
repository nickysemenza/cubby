import { expect, it } from "vitest";

import { correctnessTokens, photoFieldCrossCheck } from "./photo-correctness";

// Retrieval intentionally drops these tokens; correctness must distinguish sizes and widths.
it("keeps short, numeric, decimal and fractional identity tokens", () => {
  expect(correctnessTokens("US 10½ D · 10.5 / M / 7 / XL")).toEqual([
    "us",
    "10½",
    "d",
    "10.5",
    "m",
    "7",
    "xl",
  ]);
  const marks = photoFieldCrossCheck(
    {
      name: "Synthetic boot US 10 D",
      manufacturer: "Forge",
      model: "X7",
      identifiers: ["ABC-100"],
    },
    ["Synthetic boot US 9 D Forge X7 ABC-100"],
    {
      color: { relation: "same" },
      size: { relation: "different" },
      evidence: { firstTitle: "", secondTitle: "" },
    },
  );
  expect(
    marks
      .find((field) => field.field === "name")
      ?.tokens.find((token) => token.text === "10")?.mark,
  ).toBe("disagree-or-missing");
  expect(marks.find((field) => field.field === "model")?.mark).toBe("agree");
  expect(marks.find((field) => field.field === "color")?.mark).toBe("unknown");
  expect(marks.find((field) => field.field === "size")?.mark).toBe(
    "disagree-or-missing",
  );
  expect(
    photoFieldCrossCheck(
      {
        name: "Synthetic boot",
        manufacturer: null,
        model: null,
        identifiers: [],
      },
      [],
    ).every((field) => field.mark === "unknown"),
  ).toBe(true);
});
