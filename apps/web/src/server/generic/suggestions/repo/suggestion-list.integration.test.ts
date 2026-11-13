import { createRepoEntity } from "tooling/factories/repo";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { suggestionCountsByFamily } from "./suggestion-list";
import { listSuggestionPage } from "./suggestion-list";

describe("cross-family Suggestion list", () => {
  const ctx = withTestDb();

  // Referenced values remain presentation context, not field subjects.
  it("scopes reference-valued field proposals to their subject", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic reference drill" }),
      ctx.actor,
    );
    const current = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic current tools",
    });
    const proposed = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic proposed tools",
    });
    const { id } = await seedFieldSuggestion(ctx.db, {
      entity: "product",
      recordId: item.entityId,
      field: "categoryId",
      currentValue: current.output.id,
      suggestedValue: proposed.output.id,
      confidence: 0.9,
    });
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "field",
          recordIds: [item.id],
        })
      ).items.map((row) => row.suggestionId),
    ).toEqual([id]);
    const count = (
      await suggestionCountsByFamily(ctx.db, {
        family: "field",
        recordIds: [item.id],
      })
    ).families.find((row) => row.family === "field");
    expect(count).toMatchObject({
      pending: 1,
      fields: [
        expect.objectContaining({
          entity: "product",
          field: "categoryId",
          pending: 1,
        }),
        expect.objectContaining({
          entity: "product",
          field: "tags",
          applied: 1,
          pending: 0,
        }),
      ],
    });
    for (const record of [current.output.id, proposed.output.id]) {
      const page = await listSuggestionPage(ctx.db, {
        family: "field",
        recordEntity: "productCategory",
        recordIds: [record],
      });
      expect(page.items.map((row) => row.suggestionId)).toEqual([]);
    }
  });

  // Failure mode: the uniform row recomputes clean and drifts from the
  // statement judgment, letting a sibling charge into bulk accept.

  // Failure mode: bulk accept trusts the ids a client listed, so a charge
  // republished as no longer clean between list and accept is applied.

  // A retained predecessor and later collection must reach the same current charge proposal.
});
