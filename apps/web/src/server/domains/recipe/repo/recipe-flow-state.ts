import type { RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeOut } from "@cubby/schemas/recipe";
import {
  type RecipeFlowArtifact,
  type RecipeFlowState,
  recipeFlowArtifactSchema,
} from "@cubby/schemas/recipe-flow";
import { sha256Hex } from "@cubby/shared/sha256";

import {
  listAiAnalysesForEntityFeature,
  type StoredAiAnalysis,
} from "~/server/ai/repo/ai-analysis";
import { RECIPE_FLOW_IDENTITY } from "~/server/ai/repo/feature-identity";
import type { Database } from "~/server/db";
import { getRecipeByID } from "~/server/domains/recipe/repo/crud";
import { createAppError } from "~/server/errors/app-error";

/**
 * The stored recipe walkthrough and whether it still matches the recipe. Reads
 * never generate; `service/recipe-flow/recipe-flow.service.ts` owns generation.
 */
type FlowCandidate = StoredAiAnalysis<RecipeFlowArtifact>;

export interface RecipeFlowReadPorts {
  readonly getRecipe: (
    db: Database,
    recipeId: RecipeId,
  ) => Promise<RecipeOut | null>;
  readonly listCandidates: (
    db: Database,
    recipeId: RecipeId,
  ) => Promise<FlowCandidate[]>;
}

export const productionRecipeFlowReadPorts: RecipeFlowReadPorts = {
  getRecipe: getRecipeByID,
  listCandidates: async (db, recipeId) =>
    await listAiAnalysesForEntityFeature(db, {
      entityKind: "recipe",
      entityId: recipeId,
      feature: RECIPE_FLOW_IDENTITY.feature,
      promptVersion: RECIPE_FLOW_IDENTITY.promptVersion,
      schema: recipeFlowArtifactSchema,
    }),
};

export interface RecipeFlowPromptInput {
  title: string;
  sections: Array<{
    sectionId: string;
    name: string | null;
    ingredients: Array<{
      usageId: string;
      kind: "ingredient" | "subrecipe";
      entityId: string;
      name: string;
      rawLine: string | null;
      modifier: string | null;
      amounts: unknown[];
    }>;
    instructions: Array<{
      instructionIndex: number;
      text: string;
    }>;
  }>;
}

export function flowPromptInput(recipe: RecipeOut): RecipeFlowPromptInput {
  return {
    title: recipe.name,
    sections: recipe.sections.map((section) => ({
      sectionId: section.id,
      name: section.name ?? null,
      ingredients: section.ingredients.map((usage) => ({
        usageId: usage.id,
        kind: usage.type === "ingredient" ? "ingredient" : "subrecipe",
        entityId:
          usage.type === "ingredient" ? usage.ingredient.id : usage.recipe.id,
        name:
          usage.type === "ingredient"
            ? usage.ingredient.name
            : usage.recipe.name,
        rawLine: usage.rawLine ?? null,
        modifier: usage.modifier ?? null,
        amounts: usage.amounts,
      })),
      instructions: section.instructions.map(
        (instruction, instructionIndex) => ({
          instructionIndex,
          text: instruction.instruction,
        }),
      ),
    })),
  };
}

export async function recipeFlowContentFingerprint(
  promptInput: RecipeFlowPromptInput,
  guidance: string | null,
): Promise<string> {
  return sha256Hex(JSON.stringify({ recipe: promptInput, guidance }));
}

/**
 * A stored flow stays usable for its prompt version whichever model generated
 * it, so retiering the feature never hides flows a previous model produced;
 * only a row whose artifact disagrees with it is ignored.
 */
export async function listConsistentFlowCandidates(
  db: Database,
  recipeId: RecipeId,
  ports: RecipeFlowReadPorts,
): Promise<FlowCandidate[]> {
  return (await ports.listCandidates(db, recipeId)).filter(
    (candidate) =>
      candidate.result.model === candidate.model &&
      candidate.result.promptVersion === candidate.promptVersion,
  );
}

export async function recipeFlowOrThrow(
  db: Database,
  recipeId: RecipeId,
  ports: RecipeFlowReadPorts,
): Promise<RecipeOut> {
  const recipe = await ports.getRecipe(db, recipeId);
  if (!recipe) throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
  return recipe;
}

export async function getRecipeFlowState(
  db: Database,
  recipeId: RecipeId,
  ports: RecipeFlowReadPorts = productionRecipeFlowReadPorts,
): Promise<RecipeFlowState> {
  const [recipe, candidates] = await Promise.all([
    recipeFlowOrThrow(db, recipeId, ports),
    listConsistentFlowCandidates(db, recipeId, ports),
  ]);
  const latest = candidates[0];
  const guidance = latest?.result.guidance ?? null;
  const fingerprint = await recipeFlowContentFingerprint(
    flowPromptInput(recipe),
    guidance,
  );
  const current = candidates.find(
    (candidate) =>
      candidate.inputFingerprint === fingerprint &&
      candidate.result.contentFingerprint === fingerprint,
  );

  if (current) {
    return {
      status: "current",
      currentFingerprint: fingerprint,
      artifact: current.result,
    };
  }
  if (latest) {
    return {
      status: "stale",
      currentFingerprint: fingerprint,
      artifact: latest.result,
    };
  }
  return { status: "missing", currentFingerprint: fingerprint };
}
