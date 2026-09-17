import { testEntityId } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { Database, type DrizzleClient } from "~/server/db";
import type { VectorStorePort } from "~/server/semantic/vector-store";

import {
  buildPrefixTsQuery,
  findRelatedSearchCandidates,
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

describe("related search candidates", () => {
  /**
   * A vector match with no live SearchDocument row (a stale vector for a
   * deleted or never-indexed entity) is a "ghost": `queryById`/`query` can
   * return it, but hydration silently drops it. Callers must not assume
   * `results.length === refs.length`.
   */
  it("drops a vector match that hydration cannot find a document for", async () => {
    const liveId = testEntityId("product", "live");
    const ghostId = testEntityId("product", "ghost");

    // hydrateSearchHitRefs's SQL only ever returns rows for refs with a live
    // SearchDocument, so the first `execute` (the SearchDocument join) answers
    // with just the live row — simulating a ghost regardless of which refs
    // were asked for. hydrateSearchHitRefs also resolves display images per
    // hit; the second `execute` (product image lookup) answers with no rows,
    // which is a legitimate "no images" response and keeps this fake generic
    // instead of matching each call's SQL text.
    let executeCalls = 0;
    const fakeClient = fromPartial<DrizzleClient>({
      execute: async () => {
        executeCalls += 1;
        if (executeCalls > 1) return { rows: [] };
        return {
          rows: [
            {
              entityId: liveId,
              id: "PRD-2345",
              entityType: "product",
              title: "Live product",
              subtitle: null,
              typeHint: null,
              matchKind: "semantic",
              matchField: "embedding",
              matchReason: "Related meaning match",
              matchTerms: [],
            },
          ],
        };
      },
    });
    const db = new Database(() => ({
      client: fakeClient,
      withConnection: (fn) => fn(fakeClient),
    }));

    const port: RelatedSearchPort = {
      configured: () => true,
      embed: async () => [1, 0, 0],
      vectorStore: fromPartial<VectorStorePort>({
        query: async () => [
          { entityType: "product", entityId: liveId, similarity: 0.9 },
          { entityType: "product", entityId: ghostId, similarity: 0.8 },
        ],
      }),
    };

    const result = await findRelatedSearchCandidates(
      db,
      { query: "blue tarp", limit: 5 },
      port,
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      entityId: liveId,
      matchKind: "semantic",
    });
  });
});
