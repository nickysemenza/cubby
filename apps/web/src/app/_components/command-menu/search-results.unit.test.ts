import { describe, expect, it } from "vitest";
import {
  appendNovelSemanticResults,
  COMMAND_SEARCH_RESULT_LIMIT,
  takeCommandSearchResults,
} from "./search-results";

describe("takeCommandSearchResults", () => {
  it("preserves global rank order and caps the palette at six rows", () => {
    const ranked = [
      "inventory:1",
      "product:1",
      "task:1",
      "inventory:2",
      "recipe:1",
      "location:1",
      "product:2",
    ];

    expect(takeCommandSearchResults(ranked)).toEqual(
      ranked.slice(0, COMMAND_SEARCH_RESULT_LIMIT),
    );
  });
});

describe("appendNovelSemanticResults", () => {
  it("keeps lexical rows fixed and appends only novel semantic matches", () => {
    const lexical = [
      { entityType: "product", id: "PRD-1" },
      { entityType: "recipe", id: "RCP-1" },
    ];
    const semantic = [
      { entityType: "recipe", id: "RCP-1" },
      { entityType: "location", id: "LOC-1" },
      { entityType: "task", id: "TSK-1" },
    ];

    expect(appendNovelSemanticResults(lexical, semantic)).toEqual([
      ...lexical,
      semantic[1],
      semantic[2],
    ]);
  });
});
