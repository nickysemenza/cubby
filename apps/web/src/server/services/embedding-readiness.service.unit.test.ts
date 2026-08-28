import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";

vi.mock("~/server/semantic/embeddings", () => ({
  semanticEmbeddingsConfigured: () => false,
}));

import { getEmbeddingReadiness } from "./embedding-readiness.service";

describe("getEmbeddingReadiness", () => {
  it("does not query documents when embeddings are unavailable", async () => {
    await expect(
      getEmbeddingReadiness({} as Database, {
        entityType: "product",
        entityId: "PRD-ABCD",
      }),
    ).resolves.toBe("unavailable");
  });
});
