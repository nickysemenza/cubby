/**
 * The one runner for structured AI calls.
 *
 * Every feature used to repeat the same five-step block: build a tier
 * adapter, wrap it for error surfacing, pick model options, attach usage
 * middleware, call `chat()`. That block now lives here once, driven by the
 * feature's declaration in `features.ts` ("one declaration, several
 * consumers", docs/entities.md). A gateway-wide policy — the response-cache
 * TTL, the non-streaming wire shape the cache key needs, a new middleware —
 * is one edit here instead of ten.
 */
import { chat, type ModelMessage } from "@tanstack/ai";

import type { AiChatFeature, AiStructuredFeature } from "~/server/ai/features";
import {
  getChatModelConfig,
  type SupportedChatModel,
  adaptiveThinkingFor,
} from "~/server/ai/models";
import {
  anthropicOptions,
  cachedCall,
  compatOptions,
  fastAdapter,
  openaiOptions,
  reasoningAdapter,
  type SharedEffort,
  usageFor,
  visionBatchAdapter,
} from "~/server/clients/ai-adapters";
import type {
  GatewayCallOptions,
  GatewayMetadata,
} from "~/server/clients/ai-gateway";
import {
  type AiGatewayUsageContext,
  aiGatewayUsageMiddleware,
} from "~/server/clients/ai-gateway-usage";
import { surfaceStructuredOutputRunErrors } from "~/server/clients/structured-output-adapter";
import type { Database } from "~/server/db";

/** Everything a `chat()` call needs that the feature record does not own:
 * the prompt itself. Request builders in `clients/ai.ts` return this. */
export interface AiChatRequest {
  systemPrompts: string[];
  messages: ModelMessage[];
}

/** What one call site supplies about *this* call. */
export interface AiRunContext<T = unknown> {
  /**
   * Where the `AiUsage` row is written. Omit to run without usage accounting
   * (the eval harness and smoke paths that have no database).
   */
  db?: Database;
  /** The code path placing the call — `suggestCategory`, `select`, … */
  operation: string;
  /** Correlates calls emitted while one durable job is executing. */
  job?: { kind: string; id: string } | null;
  entity?: { entityType: string; entityId: string } | null;
  /** Whether the *caller's* own cache (AiAnalysis) hit, for the usage row. */
  cacheStatus?: "hit" | "miss" | "none";
  /**
   * Skip the gateway's response cache despite an identical request body —
   * what a "regenerate" action needs, since an unchanged prompt would
   * otherwise return the very answer the user just rejected.
   */
  force?: boolean;
  /**
   * Reject a structured output the schema alone can't catch — cross-field
   * invariants like "every operation id a plan references must be defined
   * in that same plan" (recipe-flow's `assessRecipeFlowCandidate`). When
   * this rejects the first answer, {@link runStructuredFeature} spends
   * exactly one repair call before giving up: it appends a follow-up turn
   * naming the issues and the rejected answer, then validates the retry the
   * same way. One attempt, not a loop — the old recipe-flow two-pass repair
   * had the same bound, for the same reason (cost: a validator that never
   * settles must not be free to keep re-prompting a paid model forever).
   */
  validate?: (output: T) => { ok: true } | { ok: false; issues: string[] };
}

/**
 * Everything the runner decides before it touches the network, separated out
 * so `run-feature.unit.test.ts` can assert the policy without faking an
 * adapter or a `chat()`.
 */
export interface StructuredRunPlan {
  model: SupportedChatModel;
  call: GatewayCallOptions;
  /**
   * Passed to {@link surfaceStructuredOutputRunErrors}. `false` forces the
   * non-streaming structured path, which puts `stream: false` on the wire —
   * required for the gateway's exact-body cache match, so it is exactly the
   * inverse of `cache`.
   */
  streaming: boolean;
  usage: AiGatewayUsageContext | undefined;
}

export function planStructuredRun<T = unknown>(
  spec: Pick<AiChatFeature, "feature" | "model" | "cache">,
  ctx: AiRunContext<T>,
): StructuredRunPlan {
  const metadata: GatewayMetadata = {
    feature: spec.feature,
    operation: ctx.operation,
  };
  if (ctx.entity) {
    metadata.entityType = ctx.entity.entityType;
    metadata.entityId = ctx.entity.entityId;
  }

  return {
    model: spec.model,
    call: spec.cache
      ? cachedCall({ metadata, force: ctx.force })
      : { metadata, skipCache: true },
    streaming: !spec.cache,
    usage: ctx.db
      ? usageFor(spec.model, {
          db: ctx.db,
          feature: spec.feature,
          operation: ctx.operation,
          jobKind: ctx.job?.kind ?? null,
          jobId: ctx.job?.id ?? null,
          cacheStatus: ctx.cacheStatus ?? "none",
          entity: ctx.entity ?? null,
        })
      : undefined,
  };
}

/**
 * The provider options for an arbitrary model, routed by the registry. The
 * return type is a union across the three provider option shapes (like
 * `chatAdapterFor`'s adapter union), so this is for the eval harness, which
 * runs one feature's prompt across every model. Features go through
 * {@link runStructuredFeature}, whose per-tier branches stay concretely
 * typed.
 */
export function modelOptionsFor(
  model: SupportedChatModel,
  args: { maxTokens: number; effort?: SharedEffort },
) {
  const { maxTokens } = args;
  const effort = args.effort ?? "low";
  switch (getChatModelConfig(model).route) {
    case "openai-responses":
      return openaiOptions({ maxTokens, effort });
    case "anthropic":
      return anthropicOptions({
        maxTokens,
        effort,
        adaptiveThinking: adaptiveThinkingFor(model),
      });
    case "compat":
      return compatOptions({ maxTokens, reasoningEffort: effort });
  }
}

/**
 * The one seam `run-feature.unit.test.ts` fakes. Typed as `chat` itself, so
 * the per-tier branches below keep their concrete adapter/`modelOptions`
 * pairing instead of collapsing to a union at the injection point.
 */
export interface StructuredRunPorts {
  chat: typeof chat;
}

const productionStructuredRunPorts: StructuredRunPorts = { chat };

/**
 * Cap on a rejected candidate's serialized length inside a repair turn, so a
 * large structured output (e.g. a recipe-flow dependency graph) cannot blow
 * the one retry's context budget.
 */
const MAX_REPAIR_PAYLOAD_CHARS = 8000;

/**
 * The follow-up user turn a failed {@link AiRunContext.validate} appends
 * before the one repair call: the issues the validator raised, followed by
 * the rejected answer so the model can see exactly what it produced.
 */
function buildRepairTurn<T>(issues: string[], previousOutput: T): ModelMessage {
  const serialized =
    JSON.stringify(previousOutput, null, 2) ?? String(previousOutput);
  const truncated =
    serialized.length > MAX_REPAIR_PAYLOAD_CHARS
      ? `${serialized.slice(0, MAX_REPAIR_PAYLOAD_CHARS)}\n… (truncated)`
      : serialized;

  return {
    role: "user",
    content: `The previous answer failed validation:\n${issues
      .map((issue) => `- ${issue}`)
      .join(
        "\n",
      )}\nReturn a corrected, complete answer.\n\nPrevious answer:\n${truncated}`,
  };
}

/**
 * Place one structured call for `spec`. The tier picks the adapter and the
 * shape of `modelOptions`; the branches are written out rather than shared
 * because pairing an adapter with another tier's options is exactly the
 * mistake the compiler should catch (`chatAdapterFor`'s union collapses that
 * check — see `ai-adapters.ts`).
 *
 * When `ctx.validate` rejects the first answer, this places exactly one more
 * call — a generic version of the two-pass repair recipe-flow used to run
 * itself — before throwing. See {@link AiRunContext.validate} for the bound.
 */
export async function runStructuredFeature<T>(
  spec: AiStructuredFeature<T>,
  request: AiChatRequest,
  ctx: AiRunContext<T>,
  ports: StructuredRunPorts = productionStructuredRunPorts,
): Promise<T> {
  const placeCall = async (
    callRequest: AiChatRequest,
    plan: StructuredRunPlan,
  ): Promise<T> => {
    const common = {
      systemPrompts: callRequest.systemPrompts,
      messages: callRequest.messages,
      outputSchema: spec.schema,
      middleware: aiGatewayUsageMiddleware(plan.usage),
    };
    const { streaming } = plan;

    switch (spec.tier) {
      case "fast":
        // SAFETY: `chat()`'s return type is a conditional on its own schema
        // and stream generics; with `T` still a type parameter that
        // conditional cannot resolve and widens to include the streaming
        // branches. This call passes a concrete `outputSchema` and no
        // `stream`, so the structured branch always runs and the result is
        // `T`.
        return (await ports.chat({
          ...common,
          adapter: surfaceStructuredOutputRunErrors(fastAdapter(plan.call), {
            streaming,
          }),
          modelOptions: openaiOptions({
            maxTokens: spec.maxTokens,
            effort: spec.effort,
          }),
        })) as T;
      case "visionBatch":
        // SAFETY: see the `fast` branch above — same conditional-return
        // widening, same reason the cast is sound here.
        return (await ports.chat({
          ...common,
          adapter: surfaceStructuredOutputRunErrors(
            visionBatchAdapter(plan.call),
            { streaming },
          ),
          modelOptions: compatOptions({
            maxTokens: spec.maxTokens,
            reasoningEffort: spec.effort,
          }),
        })) as T;
      case "reasoning":
        // SAFETY: see the `fast` branch above — same conditional-return
        // widening, same reason the cast is sound here.
        return (await ports.chat({
          ...common,
          adapter: surfaceStructuredOutputRunErrors(
            reasoningAdapter(plan.call),
            { streaming },
          ),
          modelOptions: anthropicOptions({
            maxTokens: spec.maxTokens,
            effort: spec.effort,
          }),
        })) as T;
    }
  };

  const firstResult = await placeCall(request, planStructuredRun(spec, ctx));
  if (!ctx.validate) return firstResult;

  const firstValidation = ctx.validate(firstResult);
  if (firstValidation.ok) return firstResult;

  const repairRequest: AiChatRequest = {
    systemPrompts: request.systemPrompts,
    messages: [
      ...request.messages,
      buildRepairTurn(firstValidation.issues, firstResult),
    ],
  };
  // `force: true` for explicitness: the repaired body already differs from
  // the first call's (the repair turn is new), so it would miss the
  // gateway's exact-body cache regardless — but a validator that always
  // rejects must never be able to land a cached rejection loop.
  const repairedResult = await placeCall(
    repairRequest,
    planStructuredRun(spec, { ...ctx, force: true }),
  );

  const repairValidation = ctx.validate(repairedResult);
  if (repairValidation.ok) return repairedResult;

  throw new Error(
    `Structured output for "${spec.feature}" is invalid after one repair attempt: ${repairValidation.issues.join("; ")}`,
  );
}
