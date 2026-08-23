import { describe, expect, it, vi } from "vitest";
import type { Database } from "~/server/db";

const mocks = vi.hoisted(() => ({
  related: vi.fn(),
  siblings: vi.fn(),
  resolve: vi.fn(),
  dismissals: vi.fn(),
  key: vi.fn(),
}));

vi.mock("~/server/services/semantic-search.service", () => ({
  findSimilarEntitiesForPair: mocks.related,
}));
vi.mock("~/server/repo/product", () => ({
  getProductsSharingTags: mocks.siblings,
}));
vi.mock("~/server/repo/shortcode-resolver", () => ({
  resolveOrThrow: mocks.resolve,
}));
vi.mock("~/server/repo/suggestion-dismissal", () => ({
  getActiveSuggestionDismissalKeys: mocks.dismissals,
  suggestionCandidateKey: mocks.key,
}));

import { getProductRelatedness } from "./relatedness.service";

describe("getProductRelatedness", () => {
  it("suppresses dismissed candidates while retaining flat merged evidence", async () => {
    mocks.resolve.mockResolvedValue("00000000-0000-4000-8000-000000000001");
    mocks.related.mockResolvedValue({
      status: "ready",
      results: [
        {
          similarity: 0.9,
          entity: { id: "PRD-SCORE", title: "Scored product" },
        },
      ],
    });
    mocks.siblings.mockResolvedValue([
      { shortcode: "PRD-SCORE", name: "Scored product", tags: ["useful"] },
      { shortcode: "PRD-HIDDEN", name: "Hidden product", tags: ["old"] },
    ]);
    mocks.dismissals.mockResolvedValue(new Set(["key:PRD-HIDDEN"]));
    mocks.key.mockImplementation(
      async (_kind: string, [id]: string[]) => `key:${id}`,
    );

    await expect(
      getProductRelatedness({} as Database, "PRD-ABCD" as never),
    ).resolves.toMatchObject({
      status: "ready",
      groups: [],
      items: [
        {
          shortcode: "PRD-SCORE",
          score: 0.9,
          evidence: [{ signal: "Similar meaning" }, { signal: "Shared tag" }],
        },
      ],
    });
  });
});
