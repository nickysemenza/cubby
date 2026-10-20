import { describe, expect, it } from "vitest";

import type { VectorStorePort } from "~/server/generic/embedding/service/semantic/vector-store";

import {
  buildPrefixTsQuery,
  findRelatedSearchHits,
  searchTerms,
} from "./search.service";
import type { RelatedSearchPort } from "./search.service";

const unavailableVectorStore: VectorStorePort = {
  configured: () => false,
  upsert: async () => {
    throw new Error("Unavailable vector store does not accept writes.");
  },
  deleteByIds: async () => {
    throw new Error("Unavailable vector store does not accept deletes.");
  },
  getByIds: async () => {
    throw new Error("Unavailable vector store cannot be read.");
  },
  query: async () => {
    throw new Error("Unavailable vector store cannot be queried.");
  },
  queryById: async () => {
    throw new Error("Unavailable vector store cannot be queried.");
  },
};

const unavailableRelatedSearch: RelatedSearchPort = {
  configured: () => false,
  embed: async () => {
    throw new Error("Unavailable embeddings do not create query vectors.");
  },
  vectorStore: unavailableVectorStore,
};

describe("search query preparation", () => {
  it("normalizes terms and creates an ANDed prefix tsquery", () => {
    expect(searchTerms("  Blue   TARP! ")).toEqual(["blue", "tarp"]);
    expect(buildPrefixTsQuery("Blue TARP")).toBe("blue:* & tarp:*");
  });
});

describe("related search availability", () => {
  it("returns unavailable without touching the database when embeddings are off", async () => {
    await expect(
      findRelatedSearchHits(
        undefined,
        { query: "related pantry item", limit: 12 },
        unavailableRelatedSearch,
      ),
    ).resolves.toEqual({ status: "unavailable", results: [] });
  });
});
