import {
  type RecipeOut,
  recipeOut,
  sectionIngredientOut,
} from "@cubby/schemas/recipe";
import type { RecipeFlowPlan } from "@cubby/schemas/recipe-flow";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { buildRecipeFlowLayout } from "./recipe-flow-layout";

const SECTION_ID = "00000000-0000-4000-8000-000000000001";
const usageIds = [
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

const recipe: RecipeOut = recipeOut.parse({
  id: testShortcode("recipe", "RCP-FLOW"),
  name: "Flow",
  meta: null,
  forkedFromRecipeId: null,
  forkedFromRecipeName: null,
  images: [],
  sections: [
    {
      id: SECTION_ID,
      name: null,
      ingredients: usageIds.map((id, index) =>
        sectionIngredientOut.parse({
          id,
          type: "ingredient",
          amounts: [],
          modifier: null,
          rawLine: null,
          recipe: null,
          ingredient: {
            id: testShortcode("ingredient", `ING-FLOW-${index}`),
            name: `Ingredient ${index}`,
            aliases: [],
            naKinds: [],
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          },
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        }),
      ),
      instructions: [
        { instruction: "Mix A and B." },
        { instruction: "Whisk C." },
        { instruction: "Combine." },
      ],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
  ],
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  dataQuality: testCompleteDataQuality(),
});

const plan: RecipeFlowPlan = {
  schemaVersion: 1,
  setup: [],
  sources: usageIds.map((usageId, index) => ({
    id: `source-${index + 1}`,
    kind: "usage",
    usageId,
    role: null,
  })),
  operations: [
    {
      id: "mix-ab",
      label: "mix",
      outputLabel: null,
      inputs: [
        { kind: "source", id: "source-1" },
        { kind: "source", id: "source-2" },
      ],
      instructionRefs: [{ sectionId: SECTION_ID, instructionIndex: 0 }],
      annotations: [],
    },
    {
      id: "whisk-c",
      label: "whisk",
      outputLabel: null,
      inputs: [{ kind: "source", id: "source-3" }],
      instructionRefs: [{ sectionId: SECTION_ID, instructionIndex: 1 }],
      annotations: [],
    },
    {
      id: "combine",
      label: "combine",
      outputLabel: null,
      inputs: [
        { kind: "operation", id: "mix-ab" },
        { kind: "operation", id: "whisk-c" },
      ],
      instructionRefs: [{ sectionId: SECTION_ID, instructionIndex: 2 }],
      annotations: [],
    },
  ],
  outputOperationIds: ["combine"],
};

describe("buildRecipeFlowLayout", () => {
  it("preserves canonical source order and places merges after dependencies", () => {
    const layout = buildRecipeFlowLayout(recipe, plan);
    expect(layout.sources.map((source) => source.id)).toEqual([
      "source-1",
      "source-2",
      "source-3",
    ]);
    const placements = new Map(
      layout.operations.map((placement) => [placement.operation.id, placement]),
    );
    expect(placements.get("mix-ab")).toMatchObject({
      column: 1,
      rowStart: 0,
      rowEnd: 1,
    });
    expect(placements.get("whisk-c")).toMatchObject({
      column: 1,
      rowStart: 2,
      rowEnd: 2,
    });
    expect(placements.get("combine")).toMatchObject({
      column: 2,
      rowStart: 0,
      rowEnd: 2,
    });
  });

  it("shifts overlapping actions right instead of emitting colliding spans", () => {
    const overlapping: RecipeFlowPlan = {
      ...plan,
      operations: [
        plan.operations[0]!,
        {
          ...plan.operations[1]!,
          id: "mix-bc",
          inputs: [
            { kind: "source", id: "source-2" },
            { kind: "source", id: "source-3" },
          ],
        },
      ],
      outputOperationIds: ["mix-ab", "mix-bc"],
    };

    const layout = buildRecipeFlowLayout(recipe, overlapping);
    expect(
      layout.operations.map(({ operation, column }) => [operation.id, column]),
    ).toEqual([
      ["mix-ab", 1],
      ["mix-bc", 2],
    ]);
  });
});
