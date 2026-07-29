import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import type { RecipeOut } from "@cubby/schemas/recipe";
import type {
  RecipeFlowArtifact,
  RecipeFlowPlan,
} from "@cubby/schemas/recipe-flow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "~/server/db";

const mocks = vi.hoisted(() => ({
  getRecipeByID: vi.fn(),
  listAnalyses: vi.fn(),
  upsertAnalysis: vi.fn(),
  recordUsage: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("~/server/repo/recipe", () => ({
  getRecipeByID: mocks.getRecipeByID,
}));
vi.mock("~/server/repo/ai-analysis", () => ({
  listAiAnalysesForEntityFeature: mocks.listAnalyses,
  upsertAiAnalysis: mocks.upsertAnalysis,
}));
vi.mock("~/server/repo/ai-usage", () => ({
  recordAiUsage: mocks.recordUsage,
}));
vi.mock("~/server/clients/anthropic", () => ({
  getAnthropicClient: () => ({ generateRecipeFlow: mocks.generate }),
}));

import { generateRecipeFlow, getRecipeFlowState } from "./recipe-flow.service";

const RECIPE_ID = unsafeRecipeId("00000000-0000-4000-8000-000000000001");
const SECTION_ID = "00000000-0000-4000-8000-000000000002";
const USAGE_ID = "00000000-0000-4000-8000-000000000003";

const recipe = {
  id: RECIPE_ID,
  name: "Toast",
  sections: [
    {
      id: SECTION_ID,
      name: null,
      ingredients: [
        {
          id: USAGE_ID,
          type: "ingredient",
          ingredient: {
            id: "00000000-0000-4000-8000-000000000004",
            name: "bread",
          },
          recipe: null,
          amounts: [],
          rawLine: "1 slice bread",
          modifier: null,
        },
      ],
      instructions: [{ instruction: "Toast until golden." }],
    },
  ],
  images: [],
} as unknown as RecipeOut;

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
});

const artifact = (
  fingerprint: string,
  guidance: string | null = null,
  model = "claude-haiku-4-5",
): RecipeFlowArtifact => ({
  plan: validPlan(),
  guidance,
  warnings: [],
  contentFingerprint: fingerprint,
  model,
  promptVersion: "2026-07-29.1",
  generatedAt: new Date("2026-07-29T12:00:00Z"),
});

const db = {} as Database;

describe("recipe-flow service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRecipeByID.mockResolvedValue(recipe);
    mocks.listAnalyses.mockResolvedValue([]);
    mocks.upsertAnalysis.mockImplementation(
      async (_db, _key, result: RecipeFlowArtifact) => result,
    );
  });

  it("returns missing, then recognizes a matching cached artifact", async () => {
    const missing = await getRecipeFlowState(db, RECIPE_ID);
    expect(missing.status).toBe("missing");

    const cached = artifact(missing.currentFingerprint);
    mocks.listAnalyses.mockResolvedValue([
      {
        inputFingerprint: missing.currentFingerprint,
        model: cached.model,
        promptVersion: cached.promptVersion,
        result: cached,
        updatedAt: cached.generatedAt,
      },
    ]);

    const current = await getRecipeFlowState(db, RECIPE_ID);
    expect(current).toMatchObject({
      status: "current",
      artifact: cached,
    });
  });

  it("persists a valid primary-model graph", async () => {
    mocks.generate.mockResolvedValue(validPlan());

    const result = await generateRecipeFlow(db, {
      id: RECIPE_ID,
      force: false,
    });

    expect(result.model).toBe("claude-haiku-4-5");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.upsertAnalysis).toHaveBeenCalledOnce();
  });

  it("repairs a contextually invalid graph with the fallback model", async () => {
    const invalid = validPlan();
    invalid.sources = [];
    invalid.operations[0]!.inputs = [{ kind: "source", id: "missing-bread" }];
    mocks.generate
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(validPlan());

    const result = await generateRecipeFlow(db, {
      id: RECIPE_ID,
      force: true,
    });

    expect(result.model).toBe("claude-sonnet-4-6");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[1]?.[2]).toMatchObject({
      candidate: invalid,
      issues: expect.arrayContaining([
        expect.stringContaining("missing from the flow"),
      ]),
    });
  });

  it("reuses persistent guidance after the recipe becomes stale", async () => {
    const stale = artifact("a".repeat(64), "keep the crust branch separate");
    mocks.listAnalyses.mockResolvedValue([
      {
        inputFingerprint: stale.contentFingerprint,
        model: stale.model,
        promptVersion: stale.promptVersion,
        result: stale,
        updatedAt: stale.generatedAt,
      },
    ]);
    mocks.generate.mockResolvedValue(validPlan());

    await generateRecipeFlow(db, { id: RECIPE_ID, force: false });

    expect(mocks.generate.mock.calls[0]?.[1]).toBe(
      "keep the crust branch separate",
    );
  });

  it("serves an exact cache hit without calling the model", async () => {
    const missing = await getRecipeFlowState(db, RECIPE_ID);
    const cached = artifact(missing.currentFingerprint);
    mocks.listAnalyses.mockResolvedValue([
      {
        inputFingerprint: cached.contentFingerprint,
        model: cached.model,
        promptVersion: cached.promptVersion,
        result: cached,
        updatedAt: cached.generatedAt,
      },
    ]);

    const result = await generateRecipeFlow(db, {
      id: RECIPE_ID,
      force: false,
    });

    expect(result).toEqual(cached);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ cacheStatus: "hit" }),
    );
  });
});
