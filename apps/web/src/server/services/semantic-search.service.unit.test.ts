import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "~/server/db";

const { globalSearch } = vi.hoisted(() => ({ globalSearch: vi.fn() }));

vi.mock("~/server/repo/search", () => ({
  globalSearch,
  hydrateSearchResultsByRefs: vi.fn(),
}));

vi.mock("~/server/semantic/embeddings", () => ({
  embedQuery: vi.fn(),
  semanticEmbeddingsConfigured: () => false,
}));

import { semanticGlobalSearch } from "./semantic-search.service";

describe("semantic-only global search", () => {
  beforeEach(() => globalSearch.mockClear());

  it("never repeats the lexical fan-out", async () => {
    const results = await semanticGlobalSearch(
      {} as Database,
      "related pantry item",
      6,
    );

    expect(results).toEqual([]);
    expect(globalSearch).not.toHaveBeenCalled();
  });
});
