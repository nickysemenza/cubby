import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
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
  vi.fn<DecisionPort>(async (input) => {
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

// Failure modes: the decision model offers an ingredient for a Product whose recorded
// category's feature refuses one (accepting it would silently refile a tool
// under Food); the gate ignores a feature inherited from an ancestor; the
// gate blocks an unclassified Product, which the ingredient link classifies.
describe("decision targets follow classification field policies", () => {
  const ctx = withTestDb();

  async function suggestIngredient(categoryId: string | null) {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const decisionPort = pickFirst();
    const input: FieldSuggestionsInput = {
      entity: "product",
      basisMode: "provided",
      targets: ["ingredientId"],
      basis: { name: "Example jasmine rice 2 lb", categoryId },
    };
    const result = await suggestFields(ctx.db, runId, input, {
      decisionPort,
      registry: { "product.ingredientId": ingredientSpec },
    });
    return { result, decisionPort };
  }

  it("never asks for a field the recorded category refuses", async () => {
    const { result, decisionPort } = await suggestIngredient(
      taxonomyShortcode("tools"),
    );
    expect(result.outcomes?.ingredientId).toEqual({
      kind: "skipped",
      reason: "no_candidates",
    });
    expect(result.suggestions.ingredientId ?? null).toBeNull();
    expect(decisionPort).not.toHaveBeenCalled();
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
    const { result, decisionPort } = await suggestIngredient(rice.output.id);
    expect(decisionPort).toHaveBeenCalled();
    expect(result.suggestions.ingredientId?.value).toBe("ING-4K7M");
  });

  it("asks for an unclassified Product, which the link would classify", async () => {
    const { result, decisionPort } = await suggestIngredient(null);
    expect(decisionPort).toHaveBeenCalled();
    expect(result.suggestions.ingredientId?.value).toBe("ING-4K7M");
  });
});
