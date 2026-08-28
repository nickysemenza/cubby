import { describe, expect, it } from "vitest";

import type { EmbeddingReadinessPort } from "./embedding-readiness.service";
import { getEmbeddingReadiness } from "./embedding-readiness.service";

const unavailableEmbeddings: EmbeddingReadinessPort = {
  configured: () => false,
  config: () => {
    throw new Error("Unavailable embeddings do not resolve configuration.");
  },
  read: async () => {
    throw new Error("Unavailable embeddings do not query documents.");
  },
};

describe("getEmbeddingReadiness", () => {
  it("does not query documents when embeddings are unavailable", async () => {
    await expect(
      getEmbeddingReadiness(
        undefined,
        { entityType: "product", entityId: "PRD-ABCD" },
        unavailableEmbeddings,
      ),
    ).resolves.toBe("unavailable");
  });
});
