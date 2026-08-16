import { describe, expect, it, vi } from "vitest";
import type { Database } from "~/server/db";

vi.mock("~/server/semantic/embeddings", () => ({
  embedQuery: vi.fn(),
  semanticEmbeddingsConfigured: () => false,
}));

import {
  buildPrefixTsQuery,
  findRelatedSearchHits,
  searchTerms,
} from "./search.service";

describe("search query preparation", () => {
  it("normalizes terms and creates an ANDed prefix tsquery", () => {
    expect(searchTerms("  Blue   TARP! ")).toEqual(["blue", "tarp"]);
    expect(buildPrefixTsQuery("Blue TARP")).toBe("blue:* & tarp:*");
  });
});

describe("related search availability", () => {
  it("returns unavailable without touching the database when embeddings are off", async () => {
    await expect(
      findRelatedSearchHits({} as Database, {
        query: "related pantry item",
        limit: 12,
      }),
    ).resolves.toEqual({ status: "unavailable", results: [] });
  });
});
