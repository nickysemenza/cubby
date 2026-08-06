import { describe, expect, it } from "vitest";
import { LEXICAL_DEBOUNCE_MS, SEMANTIC_DEBOUNCE_MS } from "./use-global-search";

describe("Command-K search timing", () => {
  it("starts lexical quickly and defers semantic enrichment", () => {
    expect(LEXICAL_DEBOUNCE_MS).toBe(75);
    expect(SEMANTIC_DEBOUNCE_MS).toBe(450);
  });
});
