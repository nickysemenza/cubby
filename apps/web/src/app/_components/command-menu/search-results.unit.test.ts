import { describe, expect, it } from "vitest";
import {
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
