import type { RecipeId } from "@cubby/schemas/identifiers";
import {
  type RecipeFlowArtifact,
  type RecipeFlowState,
  recipeFlowArtifactSchema,
  recipeFlowAiPlanSchema,
  safeNormalizeRecipeFlowAiPlan,
} from "@cubby/schemas/recipe-flow";
import type { RawRecipeOutput as RecipeOut } from "@cubby/schemas/recipe-raw-read";
import { sha256Hex } from "@cubby/shared/sha256";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { RECIPE_FLOW_IDENTITY } from "~/server/ai/policy/feature-identity";
import type { Database } from "~/server/db";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { readRecipeById } from "~/server/domains/recipe/repo/crud";
import { validateRecipeFlowPlan } from "~/server/domains/recipe/repo/recipe-flow-validation";
import { createAppError } from "~/server/errors/app-error";

/**
 * The stored recipe walkthrough and whether it still matches the recipe. Reads
 * never generate; `service/recipe-flow/recipe-flow.service.ts` owns generation.
 */
type FlowCandidate = {
  inputFingerprint: string;
  model: string;
  promptVersion: string;
  result: RecipeFlowArtifact;
  updatedAt: Date;
};

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
  getRecipe: readRecipeById,
  listCandidates: async (db, recipeId) => {
    const recipe = await readRecipeById(db, recipeId);
    const warningsFor = (plan: RecipeFlowArtifact["plan"]) => {
      const validation = recipe ? validateRecipeFlowPlan(recipe, plan) : null;
      return validation?.ok ? validation.warnings : [];
    };
    const selected = await repositoryQueries(db).execute<{
      output: unknown;
      model: string | null;
      promptVersion: string;
      createdAt: Date;
      revision: unknown;
    }>(sql`
      SELECT DISTINCT a.output, a.model, a."promptVersion", a."createdAt", k.input->${"input"}->${"revision"} AS revision
      FROM "Answer" a JOIN "Ask" k ON k.id=a."askId" JOIN "AskScope" s ON s."askId"=k.id
      WHERE a.feature=${RECIPE_FLOW_IDENTITY.feature} AND a."promptVersion"=${RECIPE_FLOW_IDENTITY.promptVersion}
        AND s."scopeKind"=${"record"} AND s."scopeKey"=${`recipe:${recipeId}`}
      ORDER BY a."createdAt" DESC LIMIT 50`);
    return selected.rows.flatMap((raw) => {
      const row = z
        .object({
          output: z.object({ value: z.unknown() }),
          model: z.string(),
          promptVersion: z.string(),
          createdAt: z.coerce.date(),
          revision: z.object({
            contentFingerprint: z.string(),
            guidance: z.string().nullable(),
          }),
        })
        .safeParse(raw);
      if (!row.success) return [];
      const retained = recipeFlowArtifactSchema.safeParse(
        row.data.output.value,
      );
      if (retained.success)
        return [
          {
            inputFingerprint: row.data.revision.contentFingerprint,
            model: row.data.model,
            promptVersion: row.data.promptVersion,
            result: retained.data,
            updatedAt: row.data.createdAt,
          },
        ];
      const candidate = recipeFlowAiPlanSchema.safeParse(row.data.output.value);
      if (!candidate.success) return [];
      const plan = safeNormalizeRecipeFlowAiPlan(candidate.data);
      if (!plan.success) return [];
      const artifact = recipeFlowArtifactSchema.parse({
        plan: plan.data,
        guidance: row.data.revision.guidance,
        contentFingerprint: row.data.revision.contentFingerprint,
        model: row.data.model,
        promptVersion: row.data.promptVersion,
        generatedAt: row.data.createdAt,
        warnings: recipe ? warningsFor(plan.data) : [],
      });
      return [
        {
          inputFingerprint: artifact.contentFingerprint,
          model: artifact.model,
          promptVersion: artifact.promptVersion,
          result: artifact,
          updatedAt: row.data.createdAt,
        },
      ];
    });
  },
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
