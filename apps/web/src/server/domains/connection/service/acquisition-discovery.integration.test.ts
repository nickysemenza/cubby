import { fromPartial } from "@total-typescript/shoehorn";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";
import { discoverAcquisitionCandidates } from "~/server/domains/connection/service/acquisition-discovery";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  createInMemoryVectorizeIndex,
  vectorId,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import {
  createProductFixture,
  createSystemUserFixture,
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
    await index.upsert([
      {
        id: vectorId(ref),
        values: vectorAt(similarity),
        metadata: { entityType: "expense" },
      },
    ]);
    return created.output.id;
  };

  it("drops weak semantic-only hits and other-brand lines, keeping same-brand charges", async () => {
    // Query embeddings book their AI call under a system background Run.
    await createSystemUserFixture(ctx.db);
    const index = semanticIndex();
    const runner = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Acme Trail Runner", manufacturer: "Acme" }),
      ctx.actor,
    );
    // Makes "Zenith" a known brand.
    await createProductFixture(
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
  });
});
