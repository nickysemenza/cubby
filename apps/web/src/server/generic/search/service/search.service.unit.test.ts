import { relatedSearchOutSchema, searchHitSchema } from "@cubby/schemas/search";
import { describe, expect, it } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";
import type { VectorStorePort } from "~/server/generic/embedding/service/semantic/vector-store";
import {
  buildPrefixTsQuery,
  searchTerms,
} from "~/server/generic/search/repo/search-lexical";

import { findRelatedSearchHits } from "./search.service";
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
  it("defaults omitted facts to an empty list and rejects more than three", () => {
    expect(searchHitSchema.shape.facts.parse(undefined)).toEqual([]);
    expect(
      searchHitSchema.shape.facts.safeParse(["a", "b", "c", "d"]).success,
    ).toBe(false);
  });

  it("normalizes terms and creates an ANDed prefix tsquery", () => {
    expect(searchTerms("  Blue   TARP! ")).toEqual(["blue", "tarp"]);
    expect(buildPrefixTsQuery("Blue TARP")).toBe("blue:* & tarp:*");
  });
});

describe("related search availability", () => {
  it("preserves unavailable diagnostics on the wire", async () => {
    const result = await findRelatedSearchHits(
      createDatabase(() => {
        throw new Error("Database should not be accessed");
      }),
      { query: "related pantry item", limit: 12 },
      {
        ...unavailableRelatedSearch,
        configured: () => true,
        embed: async () => {
          throw new Error("Synthetic upstream failure");
        },
      },
    );
    expect(relatedSearchOutSchema.parse(result)).toEqual({
      status: "unavailable",
      reason: "upstream_error",
      detail: "Synthetic upstream failure",
      results: [],
    });
  });
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
