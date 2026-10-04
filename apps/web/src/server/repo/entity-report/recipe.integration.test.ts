import type { Amount } from "@cubby/schemas/codec";
import { entityReportOut } from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { RECIPE_FLOW_PRIMARY_FEATURE } from "~/server/ai/features";
import { upsertAiAnalysis } from "~/server/repo/ai-analysis";
import { findOrCreateIngredient } from "~/server/repo/ingredient/crud";
import { createRecipe } from "~/server/repo/recipe/crud";
import { seedIngredientWithStock } from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { createTestRequestContext } from "~/server/testing/request-context";

import { buildEntityReport } from "./index";

/**
 * Two reads the recipe workflow draws on every client: whether the pantry covers the recipe, and
 * why its totals are incomplete. The wording, the ranking of fixes and the unscaled weight are the
 * server's, so web and native print one answer.
 */
describe("recipe availability and costing coverage reports", () => {
  const tdb = withTestDb();

  const services = () =>
    createTestRequestContext(tdb.db, { auth: { userId: TEST_ACTOR.userId } })
      .services;

  const line = (ingredientShortcode: string, amount: Amount) => ({
    type: "ingredient" as const,
    ingredientId: parseShortcodeFor("ingredient", ingredientShortcode),
    recipeId: null,
    amounts: [amount],
  });

  const seed = async () => {
    // 500 g on hand and a 1 cup = 120 g mapping, so 2 cups (240 g) is covered.
    const flour = await seedIngredientWithStock(
      tdb.db,
      { name: "report flour", onHand: { value: 500, unit: "g" } },
      TEST_ACTOR,
    );
    // No product at all: neither stocked nor costable.
    const mystery = await findOrCreateIngredient(tdb.db, "report mystery");
    const recipe = await createRecipe(
      tdb.db,
      {
        name: "Report tart",
        meta: null,
        sections: [
          {
            ingredients: [
              line(flour.shortcode, { value: 2, unit: "cup" }),
              line(mystery.shortcode, { value: 1, unit: "cup" }),
            ],
            instructions: [{ instruction: "Mix." }],
          },
        ],
      },
      TEST_ACTOR,
    );
    return { flour, mystery, recipe };
  };

  const report = async (
    slot: "recipe.availability" | "recipe.costing-coverage",
    id: string,
  ) =>
    entityReportOut.parse(
      await buildEntityReport(
        tdb.db,
        { slot, id },
        async () => null,
        TEST_ACTOR,
        services(),
      ),
    ).blocks;

  it("says what is covered, what to buy, and links each ingredient", async () => {
    const { mystery, recipe } = await seed();
    const blocks = await report("recipe.availability", recipe.id);

    expect(blocks[0]).toMatchObject({
      kind: "stats",
      figures: [{ text: "1 of 2 covered", tone: "warning" }],
    });
    const records = blocks.filter((block) => block.kind === "records");
    const need = records.find((block) => block.title === "Need");
    expect(need?.rows).toMatchObject([
      {
        entity: "ingredient",
        id: mystery.shortcode,
        title: "report mystery",
      },
    ]);
    const all = records.find((block) => block.title === "All ingredients (2)");
    expect(all?.rows.map((row) => row.title)).toEqual([
      "report flour",
      "report mystery",
    ]);
    // The covered row reads as such, in the shared wording.
    expect(all?.rows[0]?.statuses).toEqual([
      { label: "Have enough", tone: "positive" },
    ]);
  });

  it("names the fix for an ingredient that blocks the totals, and the unscaled weight", async () => {
    const { mystery, recipe } = await seed();
    const blocks = await report("recipe.costing-coverage", recipe.id);

    const stats = blocks[0];
    if (stats?.kind !== "stats") throw new Error("expected stats first");
    // 2 cups of flour at 120 g a cup; the mystery line cannot reach grams.
    expect(stats.figures[0]).toMatchObject({
      id: "weightGrams",
      value: 240,
      text: "240 g",
    });
    // The stocked flour has no price, so two ingredients block the cost total.
    expect(stats.figures[1]).toMatchObject({
      text: "2 block totals",
      tone: "warning",
    });

    const gaps = blocks.find((block) => block.kind === "records");
    // The highest-leverage fix (a product) ranks ahead of the price the flour lacks.
    expect(gaps?.rows[0]).toMatchObject({
      entity: "ingredient",
      id: mystery.shortcode,
      title: "report mystery",
      subtitle: "No product linked. Link one (with a USDA food) to cost it.",
      trailing: "Link product",
      badges: expect.arrayContaining(["price"]),
    });
    expect(gaps?.rows).toHaveLength(2);
  });

  it("offers to generate a walkthrough when none exists, and never generates on read", async () => {
    const { recipe } = await seed();
    const blocks = entityReportOut.parse(
      await buildEntityReport(
        tdb.db,
        { slot: "recipe.walkthrough", id: recipe.id },
        async () => null,
        TEST_ACTOR,
      ),
    ).blocks;
    expect(blocks).toMatchObject([
      {
        kind: "records",
        rows: [],
        commands: [
          {
            label: "Generate walkthrough",
            prominent: true,
            request: {
              kind: "generate-recipe-flow",
              recipeId: recipe.id,
              force: false,
            },
          },
        ],
      },
    ]);
    // It spends the model, so native asks before it runs.
    const generate = blocks[0];
    if (generate?.kind !== "records") throw new Error("expected records");
    expect(generate.commands?.[0]?.confirm).toMatch(/uses the model/);
  });

  it("shows a stored walkthrough with the recipe's own instructions, flagged stale when the recipe changed", async () => {
    const { recipe } = await seed();
    const section = recipe.sections[0]!;
    await upsertAiAnalysis(
      tdb.db,
      {
        entityKind: "recipe",
        entityId: await resolveOrThrow(tdb.db, "recipe", recipe.id),
        feature: RECIPE_FLOW_PRIMARY_FEATURE,
        inputFingerprint: "stored-before-the-recipe-changed",
      },
      {
        plan: {
          schemaVersion: 1,
          setup: [],
          sources: [
            {
              id: "flour",
              kind: "usage",
              usageId: section.ingredients[0]!.id,
              role: null,
            },
          ],
          operations: [
            {
              id: "mix",
              label: "Mix the dough",
              outputLabel: "Dough",
              inputs: [{ kind: "source", id: "flour" }],
              instructionRefs: [{ sectionId: section.id, instructionIndex: 0 }],
              annotations: [{ kind: "time", text: "2 minutes" }],
            },
          ],
          outputOperationIds: ["mix"],
          walkthrough: {
            overview: "One mix, then done.",
            stops: [
              {
                id: "stop-1",
                title: "Make the dough",
                explanation: "Everything goes in one bowl.",
                operationIds: ["mix"],
              },
            ],
          },
        },
        guidance: null,
        warnings: [],
        contentFingerprint: "a".repeat(64),
        model: RECIPE_FLOW_PRIMARY_FEATURE.model,
        promptVersion: RECIPE_FLOW_PRIMARY_FEATURE.promptVersion,
        generatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    );
    const blocks = entityReportOut.parse(
      await buildEntityReport(
        tdb.db,
        { slot: "recipe.walkthrough", id: recipe.id },
        async () => null,
        TEST_ACTOR,
      ),
    ).blocks;
    expect(blocks[0]).toMatchObject({
      kind: "note",
      tone: "warning",
      text: expect.stringMatching(/changed since this walkthrough/),
    });
    expect(blocks).toContainEqual({
      kind: "note",
      strong: true,
      text: "One mix, then done.",
    });
    const stops = blocks.find(
      (block) => block.kind === "records" && block.title === "Walkthrough",
    );
    expect(stops).toMatchObject({
      rows: [
        {
          title: "Make the dough",
          subtitle: "Everything goes in one bowl.",
          lines: [
            { text: "Mix the dough" },
            // The recipe's own instruction, unchanged, beside the AI's wording.
            { text: "Method · step 1: Mix.", tone: "muted" },
          ],
        },
      ],
    });
    const steps = blocks.find((block) => block.kind === "table");
    expect(steps).toMatchObject({
      rows: [
        {
          cells: ["Mix the dough", "report flour", "Dough", "time: 2 minutes"],
        },
      ],
    });
  });

  it("refuses a report that needs the request's services without them", async () => {
    const { recipe } = await seed();
    await expect(
      buildEntityReport(
        tdb.db,
        { slot: "recipe.availability", id: recipe.id },
        async () => null,
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/services/);
  });
});
