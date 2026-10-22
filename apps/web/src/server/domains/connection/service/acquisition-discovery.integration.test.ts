import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { fromPartial } from "@total-typescript/shoehorn";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";
import {
  discoverAcquisitionCandidates,
  discoverAcquisitionCandidateScan,
} from "~/server/domains/connection/service/acquisition-discovery";
import { seedEntityEmbedding } from "~/server/generic/embedding/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/generic/embedding/service/semantic/embeddings";
import { createInMemoryVectorizeIndex } from "~/server/generic/embedding/service/semantic/vector-store";
import {
  refreshSearchDocument,
  getSearchDocumentEmbeddingText,
  hasUnembeddedSearchDocuments,
} from "~/server/generic/search/repo/search-document";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

// Failure modes: a semantic-only neighbour with weak similarity is proposed as
// a Product's acquisition Expense; an Expense line naming a different known
// brand is proposed however similar it embeds; either gate also drops a
// genuine same-brand charge.
describe("acquisition Expense discovery gating", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  const { dimensions } = getSemanticEmbeddingConfig();
  /** A unit vector whose cosine with every query embedding is `similarity`. */
  const vectorAt = (similarity: number) =>
    Array.from({ length: dimensions }, (_, i) =>
      i === 0 ? similarity : i === 1 ? Math.sqrt(1 - similarity ** 2) : 0,
    );

  /**
   * The embedding provider is the external seam: every query embeds to the
   * first axis, and each Expense's stored vector fixes its similarity.
   */
  const semanticIndex = () => {
    const index = createInMemoryVectorizeIndex();
    const embeddings: typeof fetch = async (_url, init) => {
      const { input } = z
        .object({ input: z.array(z.string()) })
        .parse(JSON.parse(String(init?.body)));
      return Response.json({
        data: input.map((_, i) => ({ index: i, embedding: vectorAt(1) })),
      });
    };
    setCfEnv(
      fromPartial<Env & { CUBBY_TEST_AI_GATEWAY: { fetch: typeof fetch } }>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
        CUBBY_TEST_AI_GATEWAY: { fetch: embeddings },
      }),
    );
    return index;
  };

  const charge = async (
    index: ReturnType<typeof createInMemoryVectorizeIndex>,
    name: string,
    similarity: number,
  ) => {
    const created = await createRepoEntity(ctx, "expense", {
      name,
      cost: 80,
      trade: "other",
      costType: "materials",
    });
    await refreshSearchDocument(ctx.db, "expense", created.entityId);
    const ref = { entityKind: "expense" as const, entityId: created.entityId };
    const text = await getSearchDocumentEmbeddingText(
      ctx.db,
      ref.entityKind,
      ref.entityId,
    );
    if (!text) throw new Error("Synthetic Expense projection missing");
    const id = await seedEntityEmbedding(ctx.db, {
      ...text,
      config: getSemanticEmbeddingConfig(),
      values: vectorAt(similarity),
    });
    await index.upsert([
      {
        id,
        values: vectorAt(similarity),
        metadata: { entityType: "expense" },
      },
    ]);
    return created.output.id;
  };

  it("keeps valid acquisition candidates when other corpus documents have no vector", async () => {
    const index = semanticIndex();
    const runner = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Acme Runner", manufacturer: "Acme" }),
      ctx.actor,
    );
    const lexical = await charge(index, "Synthetic Acme Runner purchase", 0.95);
    const missing = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic unrelated unembedded document" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", runner.entityId);
    await refreshSearchDocument(ctx.db, "product", missing.entityId);
    expect(semanticEmbeddingsConfigured()).toBe(true);
    expect(
      await hasUnembeddedSearchDocuments(ctx.db, getSemanticEmbeddingConfig(), [
        "product",
      ]),
    ).toBe(true);
    await expect(
      discoverAcquisitionCandidates(ctx.db, {
        entityKind: "expense",
        entityId: lexical,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({ entityId: runner.id }),
        }),
      ]),
    );
    expect(
      (
        await discoverAcquisitionCandidateScan(ctx.db, {
          entityKind: "expense",
          entityId: lexical,
        })
      ).complete,
    ).toBe(false);
  });

  it("drops weak semantic-only hits and other-brand lines, keeping same-brand charges", async () => {
    const index = semanticIndex();
    const runner = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Acme Trail Runner", manufacturer: "Acme" }),
      ctx.actor,
    );
    // Makes "Zenith" a known brand.
    await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Zenith Court Classic",
        manufacturer: "Zenith",
      }),
      ctx.actor,
    );
    const otherBrand = await charge(index, "Zenith Court Shoe", 0.95);
    const weak = await charge(index, "Synthetic garden hose", 0.6);
    const lexical = await charge(index, "Acme Trail Runner shoe", 0.95);
    const semantic = await charge(index, "Acme running sneaker", 0.85);

    const targets = (
      await discoverAcquisitionCandidates(ctx.db, {
        entityKind: "product",
        entityId: runner.id,
      })
    )
      .filter((candidate) => candidate.relation === "product-expense")
      .map((candidate) => candidate.target.entityId);

    expect(targets).toEqual(expect.arrayContaining([lexical, semantic]));
    expect(targets).not.toContain(otherBrand);
    expect(targets).not.toContain(weak);

    // An unbranded Product has no brand to contradict a branded line.
    const unbranded = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Trail Runner",
        manufacturer: UNSPECIFIED_MANUFACTURER,
      }),
      ctx.actor,
    );
    expect(
      (
        await discoverAcquisitionCandidates(ctx.db, {
          entityKind: "product",
          entityId: unbranded.id,
        })
      ).map((candidate) => candidate.target.entityId),
    ).toContain(lexical);
  });
});
