import type { ImportRunId, RecipeId } from "@cubby/schemas/identifiers";
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

import { recordAiUsage } from "~/server/ai-usage";
import { RECIPE_FLOW_PRIMARY_FEATURE } from "~/server/ai/features";
import { providerFor, type SupportedChatModel } from "~/server/ai/models";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  listAiAnalysesForEntityFeature,
  type StoredAiAnalysis,
  upsertAiAnalysis,
} from "~/server/repo/ai-analysis";
import { getRecipeByID } from "~/server/repo/recipe";

import { validateRecipeFlowPlan } from "./validation";

const FLOW_FEATURES = [RECIPE_FLOW_PRIMARY_FEATURE] as const;
const FLOW_MODELS: ReadonlySet<string> = new Set<SupportedChatModel>(
  FLOW_FEATURES.map((feature) => feature.model),
);

type FlowCandidate = StoredAiAnalysis<RecipeFlowArtifact>;
type PersistFlowArtifactInput = {
  feature: (typeof FLOW_FEATURES)[number];
  fingerprint: string;
  guidance: string | null;
  plan: RecipeFlowArtifact["plan"];
  warnings: RecipeFlowArtifact["warnings"];
};

export interface RecipeFlowPorts {
  readonly getRecipe: (
    db: Database,
    recipeId: RecipeId,
  ) => Promise<RecipeOut | null>;
  readonly listCandidates: (
    db: Database,
    recipeId: RecipeId,
  ) => Promise<FlowCandidate[]>;
  readonly persistArtifact: (
    db: Database,
    recipeId: RecipeId,
    input: PersistFlowArtifactInput,
  ) => Promise<RecipeFlowArtifact>;
  readonly recordAiUsage: typeof recordAiUsage;
  readonly generateRecipeFlow: ReturnType<
    typeof getAiClient
  >["generateRecipeFlow"];
}

const productionRecipeFlowPorts: RecipeFlowPorts = {
  getRecipe: getRecipeByID,
  listCandidates: async (db, recipeId) =>
    (
      await listAiAnalysesForEntityFeature(db, {
        entityType: "recipe",
        entityId: recipeId,
        feature: RECIPE_FLOW_PRIMARY_FEATURE.feature,
        promptVersion: RECIPE_FLOW_PRIMARY_FEATURE.promptVersion,
        schema: recipeFlowArtifactSchema,
      })
    ).filter(isAllowedCandidate),
  persistArtifact: async (db, recipeId, input) => {
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
  },
  recordAiUsage,
  generateRecipeFlow: (...args) => getAiClient().generateRecipeFlow(...args),
};

// The public router accepts a recipe shortcode, then resolves it at its
// boundary. Flow persistence and AI-usage records intentionally keep the UUID.
type RecipeFlowGenerateRequest = Omit<RecipeFlowGenerateInput, "id"> & {
  id: RecipeId;
};

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

  if (!normalized.data.walkthrough) {
    return {
      ok: false,
      issues: ["generated recipe flow is missing its walkthrough"],
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
    FLOW_MODELS.has(candidate.model) &&
    candidate.result.model === candidate.model &&
    candidate.result.promptVersion === candidate.promptVersion
  );
}

async function recipeOrThrow(
  db: Database,
  recipeId: RecipeId,
  ports: RecipeFlowPorts,
): Promise<RecipeOut> {
  const recipe = await ports.getRecipe(db, recipeId);
  if (!recipe) throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
  return recipe;
}

export async function getRecipeFlowState(
  db: Database,
  recipeId: RecipeId,
  ports: RecipeFlowPorts = productionRecipeFlowPorts,
): Promise<RecipeFlowState> {
  const [recipe, candidates] = await Promise.all([
    recipeOrThrow(db, recipeId, ports),
    ports.listCandidates(db, recipeId),
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
  runId: ImportRunId,
  ports: RecipeFlowPorts,
): Promise<void> {
  const feature = FLOW_FEATURES.find(
    (candidateFeature) => candidateFeature.model === candidate.model,
  );
  if (!feature) return;
  await ports.recordAiUsage(db, {
    feature: feature.feature,
    provider: providerFor(feature.model),
    model: feature.model,
    operation: "generateRecipeFlow",
    runId,
    durationMs: 0,
    cacheStatus: "hit",
    entity: { entityType: "recipe", entityId: recipeId },
  });
}

async function persistFlowArtifact(
  db: Database,
  recipeId: RecipeId,
  input: PersistFlowArtifactInput,
  ports: RecipeFlowPorts,
): Promise<RecipeFlowArtifact> {
  return await ports.persistArtifact(db, recipeId, input);
}

export async function generateRecipeFlow(
  db: Database,
  input: RecipeFlowGenerateRequest,
  runId: ImportRunId,
  ports: RecipeFlowPorts = productionRecipeFlowPorts,
): Promise<RecipeFlowArtifact> {
  const [recipe, candidates] = await Promise.all([
    recipeOrThrow(db, input.id, ports),
    ports.listCandidates(db, input.id),
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
    await recordFlowCacheHit(db, input.id, current, runId, ports);
    return current.result;
  }

  const candidate = await ports.generateRecipeFlow(
    JSON.stringify(promptInput, null, 2),
    guidance,
    {
      db,
      runId,
      operation: "generateRecipeFlow",
      cacheStatus: "miss",
      entity: { entityType: "recipe", entityId: input.id },
      // A forced regenerate must also skip the AI Gateway's response cache:
      // the request body is unchanged, so an unforced call would be served
      // the very flow the user asked to replace.
      force: input.force,
      // The runner's own repair pass now owns rejecting an invalid
      // candidate (one retry, then throw) — this used to be a second call
      // this service placed by hand. `assessRecipeFlowCandidate` below is
      // no longer a second validation gate; it re-derives the normalized
      // `plan`/`warnings` this service needs to persist, from a candidate
      // the runner has already validated with this exact function.
      validate: (plan) => assessRecipeFlowCandidate(recipe, plan),
    },
  );
  const assessment = assessRecipeFlowCandidate(recipe, candidate);
  if (!assessment.ok) {
    // Unreachable in practice — `validate` above is the same pure function
    // applied to the same candidate, so the runner would already have
    // thrown. Kept so a future change to this extraction can't silently
    // persist something `assessRecipeFlowCandidate` disagrees with.
    throw new Error(
      `Generated recipe flow is invalid: ${assessment.issues.join("; ")}`,
    );
  }
  return await persistFlowArtifact(
    db,
    input.id,
    {
      feature: RECIPE_FLOW_PRIMARY_FEATURE,
      fingerprint,
      guidance,
      plan: assessment.plan,
      warnings: assessment.warnings,
    },
    ports,
  );
}
