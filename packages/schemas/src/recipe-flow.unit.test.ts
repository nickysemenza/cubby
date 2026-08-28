import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  normalizeRecipeFlowAiPlan,
  recipeFlowAiPlanSchema,
  recipeFlowGenerateInputSchema,
  recipeFlowPlanSchema,
} from "./recipe-flow";

const sectionId = "00000000-0000-4000-8000-000000000001";
const usageId = "00000000-0000-4000-8000-000000000002";

describe("recipeFlowPlanSchema", () => {
  it("parses the versioned provider output shape", () => {
    const result = recipeFlowPlanSchema.parse({
      schemaVersion: 1,
      setup: [],
      sources: [{ id: "flour", kind: "usage", usageId, role: null }],
      operations: [
        {
          id: "mix",
          label: "mix",
          outputLabel: "batter",
          inputs: [{ kind: "source", id: "flour" }],
          instructionRefs: [{ sectionId, instructionIndex: 0 }],
          annotations: [],
        },
      ],
      outputOperationIds: ["mix"],
    });

    expect(result.outputOperationIds).toEqual(["mix"]);
  });

  it("rejects unsafe node ids and empty operation inputs", () => {
    expect(
      () =>
        recipeFlowPlanSchema.parse({
          schemaVersion: 1,
          setup: [],
          sources: [],
          operations: [
            {
              id: "Mix Batter",
              label: "mix",
              outputLabel: null,
              inputs: [],
              instructionRefs: [{ sectionId, instructionIndex: 0 }],
              annotations: [],
            },
          ],
          outputOperationIds: ["Mix Batter"],
        }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
  });
});

describe("recipeFlowAiPlanSchema", () => {
  it("emits an Anthropic-compatible provider schema", () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(recipeFlowAiPlanSchema));

    expect(jsonSchema).not.toContain('"oneOf"');
    expect(jsonSchema).not.toContain('"minimum"');
    expect(jsonSchema).not.toContain('"maximum"');
  });

  it("normalizes the flat provider source shape into the canonical plan", () => {
    const result = normalizeRecipeFlowAiPlan(
      recipeFlowAiPlanSchema.parse({
        schemaVersion: 1,
        setup: [],
        sources: [
          {
            id: "flour",
            kind: "usage",
            usageId,
            role: null,
            label: null,
            instructionRefs: [],
          },
        ],
        operations: [
          {
            id: "mix",
            label: "mix",
            outputLabel: "batter",
            inputs: [{ kind: "source", id: "flour" }],
            instructionRefs: [{ sectionId, instructionIndex: 0 }],
            annotations: [],
          },
        ],
        outputOperationIds: ["mix"],
      }),
    );

    expect(result.sources).toEqual([
      { id: "flour", kind: "usage", usageId, role: null },
    ]);
  });
});

describe("recipeFlowGenerateInputSchema", () => {
  it("defaults force and trims guidance", () => {
    expect(
      recipeFlowGenerateInputSchema.parse({
        id: "RCP-2345",
        guidance: "  keep sauce separate  ",
      }),
    ).toMatchObject({
      force: false,
      guidance: "keep sauce separate",
    });
  });
});
