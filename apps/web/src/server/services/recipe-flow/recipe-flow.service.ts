import type { RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeOut } from "@cubby/schemas/recipe";
import {
  type RecipeFlowAiPlan,
  type RecipeFlowArtifact,
  type RecipeFlowGenerateInput,
  type RecipeFlowPlan,
  type RecipeFlowState,
  type RecipeFlowWarning,
  recipeFlowArtifactSchema,
  safeNormalizeRecipeFlowAiPlan,
} from "@cubby/schemas/recipe-flow";
import {
  RECIPE_FLOW_FALLBACK_FEATURE,
  RECIPE_FLOW_PRIMARY_FEATURE,
} from "~/server/ai/features";
import type { SupportedChatModel } from "~/server/ai/models";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  listAiAnalysesForEntityFeature,
  type StoredAiAnalysis,
  upsertAiAnalysis,
} from "~/server/repo/ai-analysis";
import { recordAiUsage } from "~/server/repo/ai-usage";
import { getRecipeByID } from "~/server/repo/recipe";
import { validateRecipeFlowPlan } from "./validation";

const FLOW_FEATURES = [
  RECIPE_FLOW_PRIMARY_FEATURE,
  RECIPE_FLOW_FALLBACK_FEATURE,
] as const;
const FLOW_MODELS = new Set<SupportedChatModel>(
  FLOW_FEATURES.map((feature) => feature.model),
);

type FlowCandidate = StoredAiAnalysis<RecipeFlowArtifact>;

interface RecipeFlowPromptInput {
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

type RecipeFlowCandidateAssessment =
  | {
      ok: true;
      plan: RecipeFlowPlan;
      warnings: RecipeFlowWarning[];
    }
  | {
      ok: false;
      issues: string[];
    };

function assessRecipeFlowCandidate(
  recipe: RecipeOut,
  candidate: RecipeFlowAiPlan,
): RecipeFlowCandidateAssessment {
  const normalized = safeNormalizeRecipeFlowAiPlan(candidate);
  if (!normalized.success) {
    return {
      ok: false,
      issues: normalized.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }

  const validation = validateRecipeFlowPlan(recipe, normalized.data);
  return validation.ok
    ? {
        ok: true,
        plan: normalized.data,
        warnings: validation.warnings,
      }
    : validation;
}

function flowPromptInput(recipe: RecipeOut): RecipeFlowPromptInput {
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

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

async function contentFingerprint(
  promptInput: RecipeFlowPromptInput,
  guidance: string | null,
): Promise<string> {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ recipe: promptInput, guidance }),
  );
  return toHex(await crypto.subtle.digest("SHA-256", encoded));
}

function isAllowedCandidate(candidate: FlowCandidate): boolean {
  return (
    FLOW_MODELS.has(candidate.model as SupportedChatModel) &&
    candidate.result.model === candidate.model &&
    candidate.result.promptVersion === candidate.promptVersion
  );
}

async function flowCandidates(
  db: Database,
  recipeId: RecipeId,
): Promise<FlowCandidate[]> {
  const candidates = await listAiAnalysesForEntityFeature(db, {
    entityType: "recipe",
    entityId: recipeId,
    feature: RECIPE_FLOW_PRIMARY_FEATURE.feature,
    promptVersion: RECIPE_FLOW_PRIMARY_FEATURE.promptVersion,
    schema: recipeFlowArtifactSchema,
  });
  return candidates.filter(isAllowedCandidate);
}

async function recipeOrThrow(
  db: Database,
  recipeId: RecipeId,
): Promise<RecipeOut> {
  const recipe = await getRecipeByID(db, recipeId);
  if (!recipe) throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
  return recipe;
}

export async function getRecipeFlowState(
  db: Database,
  recipeId: RecipeId,
): Promise<RecipeFlowState> {
  const [recipe, candidates] = await Promise.all([
    recipeOrThrow(db, recipeId),
    flowCandidates(db, recipeId),
  ]);
  const latest = candidates[0];
  const guidance = latest?.result.guidance ?? null;
  const fingerprint = await contentFingerprint(
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

async function recordFlowCacheHit(
  db: Database,
  recipeId: RecipeId,
  candidate: FlowCandidate,
): Promise<void> {
  const feature = FLOW_FEATURES.find(
    (candidateFeature) => candidateFeature.model === candidate.model,
  );
  if (!feature) return;
  await recordAiUsage(db, {
    feature: feature.feature,
    provider: "anthropic",
    model: feature.model,
    operation: "generateRecipeFlow",
    durationMs: 0,
    cacheStatus: "hit",
    entity: { entityType: "recipe", entityId: recipeId },
  });
}

async function persistFlowArtifact(
  db: Database,
  recipeId: RecipeId,
  input: {
    feature: (typeof FLOW_FEATURES)[number];
    fingerprint: string;
    guidance: string | null;
    plan: RecipeFlowArtifact["plan"];
    warnings: RecipeFlowArtifact["warnings"];
  },
): Promise<RecipeFlowArtifact> {
  const artifact = recipeFlowArtifactSchema.parse({
    plan: input.plan,
    guidance: input.guidance,
    warnings: input.warnings,
    contentFingerprint: input.fingerprint,
    model: input.feature.model,
    promptVersion: input.feature.promptVersion,
    generatedAt: new Date(),
  });
  return await upsertAiAnalysis(
    db,
    {
      entityType: "recipe",
      entityId: recipeId,
      feature: input.feature,
      inputFingerprint: input.fingerprint,
    },
    artifact,
  );
}

export async function generateRecipeFlow(
  db: Database,
  input: RecipeFlowGenerateInput,
): Promise<RecipeFlowArtifact> {
  const [recipe, candidates] = await Promise.all([
    recipeOrThrow(db, input.id),
    flowCandidates(db, input.id),
  ]);
  const latest = candidates[0];
  const guidance =
    input.guidance === undefined
      ? (latest?.result.guidance ?? null)
      : input.guidance;
  const promptInput = flowPromptInput(recipe);
  const fingerprint = await contentFingerprint(promptInput, guidance);
  const current = candidates.find(
    (candidate) =>
      candidate.inputFingerprint === fingerprint &&
      candidate.result.contentFingerprint === fingerprint,
  );
  if (current && !input.force) {
    await recordFlowCacheHit(db, input.id, current);
    return current.result;
  }

  const client = getAnthropicClient();
  const primaryCandidate = await client.generateRecipeFlow(
    JSON.stringify(promptInput, null, 2),
    guidance,
    undefined,
    {
      db,
      feature: RECIPE_FLOW_PRIMARY_FEATURE.feature,
      model: RECIPE_FLOW_PRIMARY_FEATURE.model,
      operation: "generateRecipeFlow",
      cacheStatus: "miss",
      entity: { entityType: "recipe", entityId: input.id },
    },
  );
  const primaryAssessment = assessRecipeFlowCandidate(recipe, primaryCandidate);
  if (primaryAssessment.ok) {
    return await persistFlowArtifact(db, input.id, {
      feature: RECIPE_FLOW_PRIMARY_FEATURE,
      fingerprint,
      guidance,
      plan: primaryAssessment.plan,
      warnings: primaryAssessment.warnings,
    });
  }

  const fallbackCandidate = await client.generateRecipeFlow(
    JSON.stringify(promptInput, null, 2),
    guidance,
    { candidate: primaryCandidate, issues: primaryAssessment.issues },
    {
      db,
      feature: RECIPE_FLOW_FALLBACK_FEATURE.feature,
      model: RECIPE_FLOW_FALLBACK_FEATURE.model,
      operation: "generateRecipeFlowRepair",
      cacheStatus: "miss",
      entity: { entityType: "recipe", entityId: input.id },
    },
  );
  const fallbackAssessment = assessRecipeFlowCandidate(
    recipe,
    fallbackCandidate,
  );
  if (!fallbackAssessment.ok) {
    throw new Error(
      `Recipe flow remained invalid after repair: ${fallbackAssessment.issues.join("; ")}`,
    );
  }
  return await persistFlowArtifact(db, input.id, {
    feature: RECIPE_FLOW_FALLBACK_FEATURE,
    fingerprint,
    guidance,
    plan: fallbackAssessment.plan,
    warnings: fallbackAssessment.warnings,
  });
}
