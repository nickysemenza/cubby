import type { RunId, RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeOut } from "@cubby/schemas/recipe";
import {
  type RecipeFlowAiPlan,
  type RecipeFlowArtifact,
  type RecipeFlowGenerateInput,
  type RecipeFlowPlan,
  type RecipeFlowWarning,
  recipeFlowArtifactSchema,
  safeNormalizeRecipeFlowAiPlan,
} from "@cubby/schemas/recipe-flow";

import { RECIPE_FLOW_PRIMARY_FEATURE } from "~/server/ai/features";
import { upsertAiAnalysis } from "~/server/ai/repo/ai-analysis";
import { recordFeatureUsage } from "~/server/ai/run-feature";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import {
  flowPromptInput,
  listConsistentFlowCandidates,
  productionRecipeFlowReadPorts,
  recipeFlowContentFingerprint,
  recipeFlowOrThrow,
  type RecipeFlowReadPorts,
} from "~/server/domains/recipe/repo/recipe-flow-state";

import { validateRecipeFlowPlan } from "./validation";

type PersistFlowArtifactInput = {
  feature: typeof RECIPE_FLOW_PRIMARY_FEATURE;
  fingerprint: string;
  guidance: string | null;
  plan: RecipeFlowArtifact["plan"];
  warnings: RecipeFlowArtifact["warnings"];
};

export interface RecipeFlowPorts extends RecipeFlowReadPorts {
  readonly persistArtifact: (
    db: Database,
    recipeId: RecipeId,
    input: PersistFlowArtifactInput,
  ) => Promise<RecipeFlowArtifact>;
  readonly recordFeatureUsage: typeof recordFeatureUsage;
  readonly generateRecipeFlow: ReturnType<
    typeof getAiClient
  >["generateRecipeFlow"];
}

const productionRecipeFlowPorts: RecipeFlowPorts = {
  ...productionRecipeFlowReadPorts,
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
        entityKind: "recipe",
        entityId: recipeId,
        feature: input.feature,
        inputFingerprint: input.fingerprint,
      },
      artifact,
    );
  },
  recordFeatureUsage,
  generateRecipeFlow: (...args) => getAiClient().generateRecipeFlow(...args),
};

// The public router accepts a recipe shortcode, then resolves it at its
// boundary. Flow persistence and AI-usage records intentionally keep the UUID.
type RecipeFlowGenerateRequest = Omit<RecipeFlowGenerateInput, "id"> & {
  id: RecipeId;
};

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

export function assessRecipeFlowCandidate(
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

async function recordFlowCacheHit(
  db: Database,
  recipeId: RecipeId,
  runId: RunId,
  ports: RecipeFlowPorts,
): Promise<void> {
  await ports.recordFeatureUsage(
    RECIPE_FLOW_PRIMARY_FEATURE,
    {
      db,
      runId,
      operation: "generateRecipeFlow",
      entity: { entityKind: "recipe", entityId: recipeId },
    },
    { transport: "cache", durationMs: 0, cacheStatus: "hit" },
  );
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
  runId: RunId,
  ports: RecipeFlowPorts = productionRecipeFlowPorts,
): Promise<RecipeFlowArtifact> {
  const [recipe, candidates] = await Promise.all([
    recipeFlowOrThrow(db, input.id, ports),
    listConsistentFlowCandidates(db, input.id, ports),
  ]);
  const latest = candidates[0];
  const guidance =
    input.guidance === undefined
      ? (latest?.result.guidance ?? null)
      : input.guidance;
  const promptInput = flowPromptInput(recipe);
  const fingerprint = await recipeFlowContentFingerprint(promptInput, guidance);
  const current = candidates.find(
    (candidate) =>
      candidate.inputFingerprint === fingerprint &&
      candidate.result.contentFingerprint === fingerprint,
  );
  if (current && !input.force) {
    await recordFlowCacheHit(db, input.id, runId, ports);
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
      entity: { entityKind: "recipe", entityId: input.id },
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
