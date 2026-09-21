import { describe, expect, it } from "vitest";
import { redundantTokens } from "./redundant-tokens";

describe("redundantTokens", () => {
  it("flags a tag restating a sibling field, including its plural form", () => {
    const matches = redundantTokens({
      values: ["jacquemus", "apparel", "pants", "M18"],
      restating: {
        manufacturer: "Jacquemus",
        classification: ["Apparel", "Pant"],
      },
    });
    expect(matches).toEqual([
      { value: "jacquemus", reason: "manufacturer", matched: "Jacquemus" },
      { value: "apparel", reason: "classification", matched: "Apparel" },
      { value: "pants", reason: "classification", matched: "Pant" },
    ]);
  });

  it("never flags a collection tag or a token carrying a digit or slash", () => {
    expect(
      redundantTokens({
        values: ["collection:metal-working", "grinder-4.5in", "1/4-hex"],
        restating: {
          manufacturer: "collection",
          classification: ["grinder", "hex"],
        },
      }),
    ).toEqual([]);
  });

  it("returns [] for empty values or when nothing is restated", () => {
    expect(
      redundantTokens({ values: [], restating: { manufacturer: "Acme" } }),
    ).toEqual([]);
    expect(
      redundantTokens({
        values: ["battery", "mount"],
        restating: { manufacturer: null, classification: undefined },
      }),
    ).toEqual([]);
  });
});
