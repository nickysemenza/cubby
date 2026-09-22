import { importRunId } from "@cubby/schemas/identifiers";
import {
  type RecipeOut,
  recipeOut,
  sectionIngredientOut,
} from "@cubby/schemas/recipe";
import type {
  RecipeFlowAiPlan,
  RecipeFlowArtifact,
  RecipeFlowPlan,
} from "@cubby/schemas/recipe-flow";
import {
  testCompleteDataQuality,
  testEntityId,
  testShortcode,
} from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { Database } from "~/server/db";

import {
  generateRecipeFlow,
  getRecipeFlowState,
  type RecipeFlowPorts,
} from "./recipe-flow.service";

const RECIPE_ID = testEntityId(
  "recipe",
  "00000000-0000-4000-8000-000000000001",
);
const RUN_ID = importRunId.parse("00000000-0000-4000-8000-000000000009");
const SECTION_ID = "00000000-0000-4000-8000-000000000002";
const USAGE_ID = "00000000-0000-4000-8000-000000000003";
const db = new Database(() => {
  throw new Error("Recipe-flow unit ports do not resolve a database runtime");
});

const recipe: RecipeOut = recipeOut.parse({
  id: testShortcode("recipe", "RCP-TOAST"),
  name: "Toast",
  meta: null,
  forkedFromRecipeId: null,
  forkedFromRecipeName: null,
  sections: [
    {
      id: SECTION_ID,
      name: null,
      ingredients: [
        sectionIngredientOut.parse({
          id: USAGE_ID,
          type: "ingredient",
          ingredient: {
            id: testShortcode("ingredient", "ING-BREAD"),
            name: "bread",
            aliases: [],
            naKinds: [],
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          },
          recipe: null,
          amounts: [],
          rawLine: "1 slice bread",
          modifier: null,
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        }),
      ],
      instructions: [{ instruction: "Toast until golden." }],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
  ],
  images: [],
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  dataQuality: testCompleteDataQuality(),
});

const validPlan = (): RecipeFlowPlan => ({
  schemaVersion: 1,
  setup: [],
  sources: [{ id: "bread", kind: "usage", usageId: USAGE_ID, role: null }],
  operations: [
    {
      id: "toast",
      label: "toast",
      outputLabel: "toast",
      inputs: [{ kind: "source", id: "bread" }],
      instructionRefs: [{ sectionId: SECTION_ID, instructionIndex: 0 }],
      annotations: [{ kind: "cue", text: "golden" }],
    },
  ],
  outputOperationIds: ["toast"],
  walkthrough: {
    overview: "Toast the bread.",
    stops: [
      {
        id: "toast-bread",
        title: "Toast the bread",
        explanation: "This is the recipe's only cooking operation.",
        operationIds: ["toast"],
      },
    ],
  },
});

const validCandidate = (): RecipeFlowAiPlan => ({
  ...validPlan(),
  sources: [
    {
      id: "bread",
      kind: "usage",
      usageId: USAGE_ID,
      role: null,
      label: null,
      instructionRefs: [],
    },
  ],
});

const artifact = (fingerprint: string): RecipeFlowArtifact => ({
  plan: validPlan(),
  guidance: null,
  warnings: [],
  contentFingerprint: fingerprint,
  model: "claude-sonnet-5",
  promptVersion: "2026-09-11.1",
  generatedAt: new Date("2026-07-29T12:00:00Z"),
});

class InMemoryRecipeFlowPorts {
  readonly analyses: Array<{
    inputFingerprint: string;
    model: RecipeFlowArtifact["model"];
    promptVersion: string;
    result: RecipeFlowArtifact;
    updatedAt: Date;
  }> = [];
  readonly generated: RecipeFlowAiPlan[] = [];
  readonly usage: Array<{ cacheStatus: string | null | undefined }> = [];
  readonly runContexts: Array<{ force: boolean | undefined }> = [];

  readonly ports = {
    getRecipe: async () => recipe,
    listCandidates: async () => this.analyses,
    persistArtifact: async (_db, _recipeId, input) => {
      const result = artifact(input.fingerprint);
      result.guidance = input.guidance;
      result.plan = input.plan;
      result.warnings = input.warnings;
      result.model = input.feature.model;
      result.promptVersion = input.feature.promptVersion;
      this.analyses.unshift({
        inputFingerprint: input.fingerprint,
        model: result.model,
        promptVersion: result.promptVersion,
        result,
        updatedAt: result.generatedAt,
      });
      return result;
    },
    recordAiUsage: async (_db, usage) => {
      this.usage.push({ cacheStatus: usage.cacheStatus });
    },
    // Stands in for `AiClient.generateRecipeFlow`, which now runs through
    // `runStructuredFeature`'s own bounded repair: one retry if `ctx.validate`
    // rejects the first candidate, then a throw if the retry is rejected too.
    // Mirrored here (rather than exercised through the real runner) so this
    // suite stays a unit test of the service's wiring, not of the runner —
    // that policy has its own coverage in `run-feature.unit.test.ts`.
    generateRecipeFlow: async (_prompt, _guidance, ctx) => {
      this.runContexts.push({ force: ctx.force });
      const next = (): RecipeFlowAiPlan => {
        const candidate = this.generated.shift();
        if (!candidate) throw new Error("No in-memory recipe-flow candidate");
        return candidate;
      };

      const first = next();
      if (!ctx.validate) return first;
      const firstValidation = ctx.validate(first);
      if (firstValidation.ok) return first;

      const repaired = next();
      const repairValidation = ctx.validate(repaired);
      if (repairValidation.ok) return repaired;
      throw new Error(
        `Structured output for "recipe-flow" is invalid after one repair attempt: ${repairValidation.issues.join("; ")}`,
      );
    },
  } satisfies RecipeFlowPorts;
}

describe("recipe-flow service", () => {
  let memory: InMemoryRecipeFlowPorts;

  beforeEach(() => {
    memory = new InMemoryRecipeFlowPorts();
  });

  it("returns missing, then recognizes a matching cached artifact", async () => {
    const missing = await getRecipeFlowState(db, RECIPE_ID, memory.ports);
    expect(missing.status).toBe("missing");
    const cached = artifact(missing.currentFingerprint);
    memory.analyses.push({
      inputFingerprint: missing.currentFingerprint,
      model: cached.model,
      promptVersion: cached.promptVersion,
      result: cached,
      updatedAt: cached.generatedAt,
    });

    await expect(
      getRecipeFlowState(db, RECIPE_ID, memory.ports),
    ).resolves.toMatchObject({
      status: "current",
      artifact: cached,
    });
  });

  it("persists a valid single-pass graph", async () => {
    memory.generated.push(validCandidate());

    await expect(
      generateRecipeFlow(
        db,
        { id: RECIPE_ID, force: false },
        RUN_ID,
        memory.ports,
      ),
    ).resolves.toMatchObject({ model: "claude-sonnet-5" });
    expect(memory.analyses).toHaveLength(1);
  });

  it("persists after one repair when the first pass is invalid but the second is valid", async () => {
    // `ports.generateRecipeFlow` stands in for `AiClient.generateRecipeFlow`,
    // which now runs through `runStructuredFeature`'s own one-repair-attempt
    // policy — this in-memory port applies the `ctx.validate` the service
    // wired through, the same way the real runner does, so a first invalid
    // candidate followed by a valid one still resolves to the valid plan.
    const invalid = validCandidate();
    invalid.sources = [];
    invalid.operations[0]!.inputs = [{ kind: "source", id: "missing-bread" }];
    memory.generated.push(invalid, validCandidate());

    await expect(
      generateRecipeFlow(
        db,
        { id: RECIPE_ID, force: true },
        RUN_ID,
        memory.ports,
      ),
    ).resolves.toMatchObject({ model: "claude-sonnet-5" });
    expect(memory.analyses).toHaveLength(1);
  });

  it("throws when both the first pass and its repair are invalid", async () => {
    const invalid = validCandidate();
    invalid.sources = [];
    invalid.operations[0]!.inputs = [{ kind: "source", id: "missing-bread" }];
    memory.generated.push(invalid, structuredClone(invalid));

    await expect(
      generateRecipeFlow(
        db,
        { id: RECIPE_ID, force: true },
        RUN_ID,
        memory.ports,
      ),
    ).rejects.toThrow(/invalid/i);
    expect(memory.analyses).toHaveLength(0);
  });

  it("throws when a pass missing its walkthrough is never repaired", async () => {
    const missingWalkthrough = validCandidate();
    delete missingWalkthrough.walkthrough;
    memory.generated.push(
      missingWalkthrough,
      structuredClone(missingWalkthrough),
    );

    await expect(
      generateRecipeFlow(
        db,
        { id: RECIPE_ID, force: true },
        RUN_ID,
        memory.ports,
      ),
    ).rejects.toThrow(/walkthrough/i);
    expect(memory.analyses).toHaveLength(0);
  });

  it("skips the gateway response cache when the caller forces a regenerate", async () => {
    // The request body is identical on a forced regenerate, so without this
    // the gateway would hand back the very flow the user asked to replace.
    memory.generated.push(validCandidate());
    await generateRecipeFlow(
      db,
      { id: RECIPE_ID, force: true },
      RUN_ID,
      memory.ports,
    );
    expect(memory.runContexts).toEqual([{ force: true }]);
  });

  it("leaves the gateway response cache in play for an unforced generate", async () => {
    memory.generated.push(validCandidate());
    await generateRecipeFlow(
      db,
      { id: RECIPE_ID, force: false },
      RUN_ID,
      memory.ports,
    );
    expect(memory.runContexts).toEqual([{ force: false }]);
  });

  it("serves an exact cache hit without calling the provider", async () => {
    const missing = await getRecipeFlowState(db, RECIPE_ID, memory.ports);
    const cached = artifact(missing.currentFingerprint);
    memory.analyses.push({
      inputFingerprint: cached.contentFingerprint,
      model: cached.model,
      promptVersion: cached.promptVersion,
      result: cached,
      updatedAt: cached.generatedAt,
    });

    await expect(
      generateRecipeFlow(
        db,
        { id: RECIPE_ID, force: false },
        RUN_ID,
        memory.ports,
      ),
    ).resolves.toEqual(cached);
    expect(memory.usage).toEqual([{ cacheStatus: "hit" }]);
  });
});
