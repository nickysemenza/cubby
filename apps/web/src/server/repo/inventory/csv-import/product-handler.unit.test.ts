import { describe, it, expect } from "vitest";
import { parseAliasesString, findNewAliases } from "./product-handler";

describe("parseAliasesString", () => {
  it("should parse semicolon-separated aliases", () => {
    expect(parseAliasesString("sugar; granulated sugar; white sugar")).toEqual([
      "sugar",
      "granulated sugar",
      "white sugar",
    ]);
  });

  it("should handle single alias", () => {
    expect(parseAliasesString("sugar")).toEqual(["sugar"]);
  });

  it("should handle empty string", () => {
    expect(parseAliasesString("")).toEqual([]);
  });

  it("should handle null", () => {
    expect(parseAliasesString(null)).toEqual([]);
  });

  it("should handle undefined", () => {
    expect(parseAliasesString(undefined)).toEqual([]);
  });

  it("should trim whitespace", () => {
    expect(parseAliasesString("  sugar  ;  salt  ")).toEqual(["sugar", "salt"]);
  });

  it("should filter empty entries", () => {
    expect(parseAliasesString("sugar;;salt")).toEqual(["sugar", "salt"]);
  });
});

describe("findNewAliases", () => {
  it("should return all aliases when none exist", () => {
    const newAliases = findNewAliases(["sugar", "salt"], []);
    expect(newAliases).toEqual(["sugar", "salt"]);
  });

  it("should return empty when all aliases already exist", () => {
    const newAliases = findNewAliases(
      ["sugar", "granulated sugar"],
      ["sugar", "granulated sugar"],
    );
    expect(newAliases).toEqual([]);
  });

  it("should be case insensitive", () => {
    const newAliases = findNewAliases(
      ["Sugar", "GRANULATED SUGAR"],
      ["sugar", "granulated sugar"],
    );
    expect(newAliases).toEqual([]);
  });

  it("should return only new aliases", () => {
    const newAliases = findNewAliases(
      ["sugar", "granulated sugar", "white sugar"],
      ["sugar", "granulated sugar"],
    );
    expect(newAliases).toEqual(["white sugar"]);
  });

  it("should handle case differences and return new ones", () => {
    const newAliases = findNewAliases(
      ["Sugar", "Brown Sugar"],
      ["sugar", "white sugar"],
    );
    // "Sugar" matches "sugar" (case insensitive), so only "Brown Sugar" is new
    expect(newAliases).toEqual(["Brown Sugar"]);
  });

  it("should handle empty new aliases", () => {
    const newAliases = findNewAliases([], ["sugar", "salt"]);
    expect(newAliases).toEqual([]);
  });
});
