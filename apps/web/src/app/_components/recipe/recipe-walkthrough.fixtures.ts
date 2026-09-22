import { recipeOut } from "@cubby/schemas/recipe";
import type { RecipeFlowPlan } from "@cubby/schemas/recipe-flow";
import {
  testCompleteDataQuality,
  testEntityId,
  testShortcode,
} from "@cubby/schemas/testing";

const sectionId = testEntityId("recipe", "walkthrough-section");
const usageId = testEntityId("recipe", "walkthrough-sugar");
const createdAt = new Date("2026-01-01");

export const walkthroughRecipe = recipeOut.parse({
  id: testShortcode("recipe", "RCP-WALKTHROUGH"),
  name: "Example lemon cakes",
  images: [],
  meta: null,
  forkedFromRecipeId: null,
  forkedFromRecipeName: null,
  sections: [
    {
      id: sectionId,
      name: "Cakes",
      ingredients: [
        {
          id: usageId,
          type: "ingredient",
          amounts: [{ value: 100, unit: "g" }],
          modifier: "divided",
          rawLine: "100 g sugar, divided",
          recipe: null,
          ingredient: {
            id: testShortcode("ingredient", "ING-SUGAR"),
            name: "Sugar",
            aliases: [],
            naKinds: [],
            createdAt,
            updatedAt: createdAt,
          },
          createdAt,
          updatedAt: createdAt,
        },
      ],
      instructions: [
        { instruction: "Line the cake tin." },
        { instruction: "Whisk half of the sugar into the batter." },
        {
          instruction:
            "Sprinkle with the remaining sugar and bake until golden.",
        },
        { instruction: "Serve with lemon slices." },
      ],
      createdAt,
      updatedAt: createdAt,
    },
  ],
  createdAt,
  updatedAt: createdAt,
  dataQuality: testCompleteDataQuality(),
});

export const walkthroughPlan: RecipeFlowPlan = {
  schemaVersion: 1,
  setup: [
    {
      id: "line-tin",
      label: "Line the tin",
      instructionRefs: [{ sectionId, instructionIndex: 0 }],
      annotations: [],
    },
  ],
  sources: [{ id: "sugar", kind: "usage", usageId, role: null }],
  operations: [
    {
      id: "mix",
      label: "Mix the batter",
      outputLabel: "Cake batter",
      inputs: [{ kind: "source", id: "sugar" }],
      instructionRefs: [{ sectionId, instructionIndex: 1 }],
      annotations: [],
    },
    {
      id: "bake",
      label: "Bake the cakes",
      outputLabel: "Baked cakes",
      inputs: [
        { kind: "operation", id: "mix" },
        { kind: "source", id: "sugar" },
      ],
      instructionRefs: [{ sectionId, instructionIndex: 2 }],
      annotations: [{ kind: "cue", text: "Golden" }],
    },
  ],
  outputOperationIds: ["bake"],
  walkthrough: {
    overview:
      "Prepare the tin, mix the batter, then finish with the remaining sugar before baking. Follow the golden colour cue in the recipe.",
    stops: [
      {
        id: "batter",
        title: "Start with the batter",
        explanation:
          "The sugar is divided between the batter and the topping. Keep the remaining sugar for the next step.",
        operationIds: ["mix"],
      },
      {
        id: "oven",
        title: "Finish and bake",
        explanation:
          "The prepared batter comes together with the remaining sugar here. The original recipe uses colour to describe when the cakes are ready.",
        operationIds: ["bake"],
      },
    ],
  },
};
