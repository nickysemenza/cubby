import {
  type RecipeOut,
  recipeOut,
  sectionIngredientOut,
} from "@cubby/schemas/recipe";
import {
  type RecipeFlowPlan,
  recipeFlowGenerateInputSchema,
} from "@cubby/schemas/recipe-flow";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { validateRecipeFlowPlan } from "./validation";

const SECTION_ID = "00000000-0000-4000-8000-000000000001";
const FLOUR_USAGE = "00000000-0000-4000-8000-000000000002";
const WATER_USAGE = "00000000-0000-4000-8000-000000000003";

const recipe: RecipeOut = recipeOut.parse({
  id: testShortcode("recipe", "RCP-BREAD"),
  name: "Bread",
  forkedFromRecipeId: null,
  forkedFromRecipeName: null,
  sections: [
    {
      id: SECTION_ID,
      name: null,
      ingredients: [
        sectionIngredientOut.parse({
          id: FLOUR_USAGE,
          type: "ingredient",
          ingredient: {
            id: testShortcode("ingredient", "ING-FLOUR"),
            name: "flour",
            aliases: [],
            naKinds: [],
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          },
          recipe: null,
          amounts: [],
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        }),
        sectionIngredientOut.parse({
          id: WATER_USAGE,
          type: "ingredient",
          ingredient: {
            id: testShortcode("ingredient", "ING-WATER"),
            name: "water",
            aliases: [],
            naKinds: [],
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          },
          recipe: null,
          amounts: [],
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        }),
      ],
      instructions: [
        { instruction: "Mix the flour and water." },
        { instruction: "Bake until deeply browned." },
      ],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
  ],
  images: [],
  meta: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  dataQuality: testCompleteDataQuality(),
});

const validPlan = (): RecipeFlowPlan => ({
  schemaVersion: 1,
  setup: [],
  sources: [
    { id: "flour", kind: "usage", usageId: FLOUR_USAGE, role: null },
    { id: "water", kind: "usage", usageId: WATER_USAGE, role: null },
  ],
  operations: [
    {
      id: "mix",
      label: "mix",
      outputLabel: "dough",
      inputs: [
        { kind: "source", id: "flour" },
        { kind: "source", id: "water" },
      ],
      instructionRefs: [{ sectionId: SECTION_ID, instructionIndex: 0 }],
      annotations: [],
    },
    {
      id: "bake",
      label: "bake",
      outputLabel: "bread",
      inputs: [{ kind: "operation", id: "mix" }],
      instructionRefs: [{ sectionId: SECTION_ID, instructionIndex: 1 }],
      annotations: [{ kind: "cue", text: "deeply browned" }],
    },
  ],
  outputOperationIds: ["bake"],
  walkthrough: {
    overview: "Mix the dough, then bake it.",
    stops: [
      {
        id: "make-dough",
        title: "Make the dough",
        explanation: "This combines the flour and water into the dough.",
        operationIds: ["mix"],
      },
      {
        id: "bake-bread",
        title: "Bake the bread",
        explanation: "Bake the prepared dough to finish the bread.",
        operationIds: ["bake"],
      },
    ],
  },
});

describe("validateRecipeFlowPlan", () => {
  it("accepts a complete acyclic graph", () => {
    expect(validateRecipeFlowPlan(recipe, validPlan())).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it("rejects missing usages, dangling inputs, and non-terminal outputs", () => {
    const plan = validPlan();
    plan.sources = plan.sources.filter((source) => source.id !== "water");
    plan.operations[0]?.inputs.push({
      kind: "source",
      id: "missing",
    });
    plan.outputOperationIds = ["mix"];

    const result = validateRecipeFlowPlan(recipe, plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid graph");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`ingredient usage ${WATER_USAGE} is missing`),
        expect.stringContaining("unknown source missing"),
        expect.stringContaining("output operation mix is not terminal"),
      ]),
    );
  });

  it("rejects dependency cycles", () => {
    const plan = validPlan();
    plan.operations[0]?.inputs.push({ kind: "operation", id: "bake" });

    const result = validateRecipeFlowPlan(recipe, plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid graph");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("operation dependency cycle"),
      ]),
    );
  });

  it("rejects duplicate stop IDs, invalid operation references, repeated operations, and dependency inversions", () => {
    const plan = validPlan();
    plan.walkthrough!.stops = [
      {
        id: "bake-first",
        title: "Bake first",
        explanation: "An invalid ordering for validation coverage.",
        operationIds: ["bake", "mix", "bake", "missing"],
      },
      {
        id: "bake-first",
        title: "Still bake first",
        explanation: "A duplicate stop ID for validation coverage.",
        operationIds: ["mix"],
      },
    ];

    const result = validateRecipeFlowPlan(recipe, plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid walkthrough");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "walkthrough stop bake-first appears more than once",
        "walkthrough operation bake appears more than once",
        "walkthrough stop bake-first references unknown operation missing",
        "walkthrough orders operation bake before dependency mix",
      ]),
    );
  });

  it("rejects a walkthrough that omits an operation", () => {
    const plan = validPlan();
    plan.walkthrough!.stops[0]!.operationIds = ["mix"];
    plan.walkthrough!.stops.splice(1, 1);

    const result = validateRecipeFlowPlan(recipe, plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid walkthrough");
    expect(result.issues).toContain("walkthrough omits operation bake");
  });

  it("keeps operations that cite the same instruction in one walkthrough stop", () => {
    const plan = validPlan();
    plan.operations[1]!.instructionRefs = [
      { sectionId: SECTION_ID, instructionIndex: 0 },
    ];
    plan.setup.push({
      id: "prepare-oven",
      label: "Prepare the oven",
      instructionRefs: [{ sectionId: SECTION_ID, instructionIndex: 1 }],
      annotations: [],
    });

    const result = validateRecipeFlowPlan(recipe, plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fragmented instruction");
    expect(result.issues).toContain(
      `walkthrough separates instruction ${SECTION_ID}:0 across stops make-dough and bake-bread`,
    );
  });

  it("requires a walkthrough to cover every nonempty instruction through setup or an operation", () => {
    const plan = validPlan();
    plan.operations[1]!.instructionRefs = [
      { sectionId: SECTION_ID, instructionIndex: 0 },
    ];
    plan.sources.push({
      id: "steam-water",
      kind: "unlisted",
      label: "water for steam",
      instructionRefs: [{ sectionId: SECTION_ID, instructionIndex: 1 }],
    });
    plan.operations[1]!.inputs.push({
      kind: "source",
      id: "steam-water",
    });

    const result = validateRecipeFlowPlan(recipe, plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected incomplete walkthrough");
    expect(result.issues).toContain(
      "walkthrough omits instruction 2 in the recipe",
    );
  });

  it("keeps incomplete instruction coverage as a warning for legacy flows", () => {
    const plan = validPlan();
    delete plan.walkthrough;
    plan.operations[1]!.instructionRefs = [
      { sectionId: SECTION_ID, instructionIndex: 0 },
    ];

    const result = validateRecipeFlowPlan(recipe, plan);
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "unreferenced-instruction" }),
        ]),
      }),
    );
  });

  it("allows instruction-backed unlisted inputs and warns visibly", () => {
    const plan = validPlan();
    plan.sources.push({
      id: "steam-water",
      kind: "unlisted",
      label: "water for steam",
      instructionRefs: [{ sectionId: SECTION_ID, instructionIndex: 1 }],
    });
    plan.operations[1]?.inputs.push({
      kind: "source",
      id: "steam-water",
    });

    const result = validateRecipeFlowPlan(recipe, plan);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid graph");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unlisted-input" }),
      ]),
    );
  });

  it("requires distinct roles when a usage is divided", () => {
    const plan = validPlan();
    plan.sources.push({
      id: "flour-dusting",
      kind: "usage",
      usageId: FLOUR_USAGE,
      role: null,
    });
    plan.operations[1]?.inputs.push({
      kind: "source",
      id: "flour-dusting",
    });

    const result = validateRecipeFlowPlan(recipe, plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid graph");
    expect(result.issues).toContain(
      `divided ingredient usage ${FLOUR_USAGE} needs a distinct role on every source`,
    );
  });
});

// Shortcodes are the public id; a uuid must never be accepted here. Split out
// of api/routers/recipe/flow.integration.test.ts, where it was bolted onto a
// caller round-trip and referenced nothing that test had created.
describe("recipeFlowGenerateInputSchema", () => {
  it("rejects a uuid where a recipe shortcode is required", () => {
    expect(
      recipeFlowGenerateInputSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });
});
