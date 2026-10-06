import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { JevPort } from "~/server/ai/jev";
import { createProductCategory } from "~/server/repo/product-category";
import { ensureRun } from "~/server/runs/ensure-run";

import type { ReferenceSuggestSpec } from "./registry";
import { suggestFields } from "./suggest-fields";

type Candidate = { id: string; title: string };

// A fixed one-ingredient roster: the gate under test runs before any roster.
const ingredientSpec: ReferenceSuggestSpec<Candidate> = {
  kind: "reference",
  entity: "ingredient",
  rules: "Pick the ingredient.",
  maxCandidates: 10,
  roster: async () => [{ id: "ING-4K7M", title: "jasmine rice" }],
  idOf: (c) => c.id,
  labelOf: (c) => c.title,
  renderLine: (c) => `${c.id} | ${c.title}`,
  subject: (basis) => `Product: ${basis.name ?? ""}`,
};

const pickFirst = () =>
  vi.fn<JevPort>(async (input) => {
    const keys = Object.keys(input.questions.selection.criteria);
    const choice = keys[0]!;
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence: 0.99,
          probabilities: Object.fromEntries(
            keys.map((key) => [
              key,
              key === choice ? 0.99 : 0.01 / (keys.length - 1),
            ]),
          ),
        },
      },
    };
  });

// Failure modes: Jev offers an ingredient for a Product whose recorded
// category's feature refuses one (accepting it would silently refile a tool
// under Food); the gate ignores a feature inherited from an ancestor; the
// gate blocks an unclassified Product, which the ingredient link classifies.
describe("Jev targets follow classification field policies", () => {
  const ctx = withTestDb();

  async function suggestIngredient(categoryId: string | null) {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const jev = pickFirst();
    const input: FieldSuggestionsInput = {
      entity: "product",
      basisMode: "provided",
      targets: ["ingredientId"],
      basis: { name: "Example jasmine rice 2 lb", categoryId },
    };
    const result = await suggestFields(ctx.db, runId, input, {
      jev,
      registry: { "product.ingredientId": ingredientSpec },
    });
    return { result, jev };
  }

  it("never asks for a field the recorded category refuses", async () => {
    const { result, jev } = await suggestIngredient(taxonomyShortcode("tools"));
    expect(result.outcomes?.ingredientId).toEqual({
      kind: "skipped",
      reason: "no_candidates",
    });
    expect(result.suggestions.ingredientId ?? null).toBeNull();
    expect(jev).not.toHaveBeenCalled();
  });

  it("asks under a category that inherits the admitting feature", async () => {
    const rice = await createProductCategory(
      ctx.db,
      {
        spendingCategoryId: null,
        spendingCategoryMode: "inherit",
        name: "Example rice",
        aliases: [],
        description: null,
        parentId: taxonomyShortcode("food"),
        sortOrder: 0,
        feature: null,
      },
      ctx.actor,
    );
    const { result, jev } = await suggestIngredient(rice.output.id);
    expect(jev).toHaveBeenCalled();
    expect(result.suggestions.ingredientId?.value).toBe("ING-4K7M");
  });

  it("asks for an unclassified Product, which the link would classify", async () => {
    const { result, jev } = await suggestIngredient(null);
    expect(jev).toHaveBeenCalled();
    expect(result.suggestions.ingredientId?.value).toBe("ING-4K7M");
  });
});
