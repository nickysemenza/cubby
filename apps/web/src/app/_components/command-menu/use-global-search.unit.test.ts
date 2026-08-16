import { describe, expect, it } from "vitest";
import { LEXICAL_DEBOUNCE_MS } from "./use-global-search";

describe("Command-K search timing", () => {
  it("waits briefly before lexical navigation search", () => {
    expect(LEXICAL_DEBOUNCE_MS).toBe(100);
  });
});
