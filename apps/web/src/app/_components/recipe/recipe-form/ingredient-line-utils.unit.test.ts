import { describe, expect, it } from "vitest";
import {
  parsedIngredientNames,
  parseIngredientLines,
  resolveParsedIngredientGroups,
} from "./ingredient-line-utils";

describe("ingredient line helpers", () => {
  it("parses non-empty lines and dedupes parsed names", () => {
    const parsed = parseIngredientLines(["1 cup flour", " ", "2 cup flour"]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.raw).toBe("1 cup flour");
    expect(parsed[0]?.parsed.name).toBe("flour");
    expect(parsedIngredientNames(parsed)).toEqual(["flour"]);
  });

  it("can keep or drop lines without a parsed ingredient name", () => {
    const parsed = parseIngredientLines(["1 cup"]);
    const parsedForImport = parseIngredientLines(["1 cup"], {
      requireName: true,
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.raw).toBe("1 cup");
    expect(parsed[0]?.parsed.name).toBe("");
    expect(parsedIngredientNames(parsed)).toEqual([]);
    expect(parsedForImport).toEqual([]);
  });

  it("resolves grouped lines once per unique ingredient name", async () => {
    const calls: string[] = [];
    const parsedGroups = [
      parseIngredientLines(["1 cup flour"], { requireName: true }),
      parseIngredientLines(["2 cup flour", "1 egg"], { requireName: true }),
    ];
    const groups = await resolveParsedIngredientGroups(
      parsedGroups,
      async (name) => {
        calls.push(name);
        return { id: `id-${name}`, name, aliases: [] };
      },
    );

    expect(calls).toEqual(["flour", "egg"]);
    expect(groups.map((g) => g.map((i) => i.ingredient?.id))).toEqual([
      ["id-flour"],
      ["id-flour", "id-egg"],
    ]);
    expect(groups[0]?.[0]?.rawLine).toBe("1 cup flour");
  });

  // Regression: an imported line whose wording is a registered alias of the
  // matched ingredient (e.g. "egg" → the "large brown egg" ingredient) must
  // carry that ingredient's aliases onto the row, so the Re-parse drift check
  // recognizes the alias match instead of false-flagging drift.
  it("threads the matched ingredient's aliases onto each row", async () => {
    const parsedGroups = [
      parseIngredientLines(["1 egg"], { requireName: true }),
    ];
    const groups = await resolveParsedIngredientGroups(
      parsedGroups,
      async (name) => ({
        id: `id-${name}`,
        name: "large brown egg",
        aliases: ["egg", "eggs"],
      }),
    );

    expect(groups[0]?.[0]?.aliases).toEqual(["egg", "eggs"]);
  });
});
