import { describe, expect, it } from "vitest";

import { computeUnusedAliases } from "./unused-aliases";

// Helper: a parse map where each name resolves to the given ingredient ids.
const resolved = (entries: Record<string, string[]>) =>
  new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));

describe("computeUnusedAliases", () => {
  it("flags an alias that equals the ingredient's own name (case-insensitive)", () => {
    expect(
      computeUnusedAliases({
        id: "i1",
        name: "Scallion",
        aliases: ["scallion"],
        resolvedNameToIngredientIds: resolved({ scallion: ["i1"] }),
      }),
    ).toEqual(["scallion"]);
  });

  it("flags a case-insensitive duplicate alias, keeping the first occurrence", () => {
    // "Onion" matches a recipe line so it's kept; the later "onion" dup is flagged.
    expect(
      computeUnusedAliases({
        id: "i1",
        name: "Allium",
        aliases: ["Onion", "onion"],
        resolvedNameToIngredientIds: resolved({ onion: ["i1"] }),
      }),
    ).toEqual(["onion"]);
  });

  it("flags an alias no recipe line resolves to this ingredient", () => {
    expect(
      computeUnusedAliases({
        id: "i1",
        name: "Allium",
        aliases: ["scallion"],
        resolvedNameToIngredientIds: resolved({}), // never matched
      }),
    ).toEqual(["scallion"]);
  });

  it("flags an alias matched only for a DIFFERENT ingredient", () => {
    expect(
      computeUnusedAliases({
        id: "i1",
        name: "Allium",
        aliases: ["pepper"],
        resolvedNameToIngredientIds: resolved({ pepper: ["i2"] }), // routes elsewhere
      }),
    ).toEqual(["pepper"]);
  });

  it("does NOT flag an alias matched by a recipe line for this ingredient", () => {
    expect(
      computeUnusedAliases({
        id: "i1",
        name: "Green onion",
        aliases: ["scallion"],
        resolvedNameToIngredientIds: resolved({ scallion: ["i1", "i2"] }),
      }),
    ).toEqual([]);
  });

  it("returns empty for an ingredient with no aliases", () => {
    expect(
      computeUnusedAliases({
        id: "i1",
        name: "Salt",
        aliases: [],
        resolvedNameToIngredientIds: resolved({}),
      }),
    ).toEqual([]);
  });
});
