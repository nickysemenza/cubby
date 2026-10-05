import type { RunId } from "@cubby/schemas/identifiers";
import {
  fetchExternalResponse,
  readResponseWithLimit,
} from "@cubby/shared/external-fetch";
/**
 * The one runner for structured AI calls.
 *
 * Every feature used to repeat the same five-step block: build a tier
 * adapter, wrap it for error surfacing, pick model options, attach usage
 * middleware, call `chat()`. That block now lives here once, driven by the
 * feature's declaration in `features.ts` ("one declaration, several
 * consumers", docs/entities.md). A gateway-wide policy — the response-cache
 * TTL, a new reasoning dial, a tier's model — is one edit here instead of
 * ten.
 *
 * pi-ai has no native structured-output mode: every structured call forces
 * exactly one call to a synthetic `respond` tool whose parameters are the
 * feature's schema (made JSON-Schema-strict, as every provider's
 * constrained sampling requires), and the answer is the tool call's
 * arguments, not response text.
 */
import {
  type AssistantMessage,
  type Context,
  type ImageContent,
  type JsonObject,
  type JsonValue,
  type TextContent,
  type Tool,
  type ToolCall,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { parse as parseContentType } from "content-type";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import { recordAiUsage } from "~/server/ai-usage";
import type {
  AiChatFeature,
  AiFeature,
  AiStructuredFeature,
} from "~/server/ai/features";
import {
  getChatModelConfig,
  providerFor,
  type SupportedChatModel,
  type SupportedEmbeddingModel,
} from "~/server/ai/models";
import {
  type AiResponseCacheKeyInput,
  type ApplicationCacheStatus,
  withAiResponseCache,
} from "~/server/ai/response-cache";
import {
  chatCompletionOptionsFor,
  cachedCall,
  piCallTarget,
  type AnthropicEffort,
  type OpenAiEffort,
  type PiCallTarget,
  type SharedEffort,
} from "~/server/clients/ai-adapters";
import type {
  GatewayCallOptions,
  GatewayMetadata,
  GatewayResponseFailure,
} from "~/server/clients/ai-gateway";
import { wrapAiGatewayError } from "~/server/clients/ai-gateway-error";
import type { Database } from "~/server/db";

/** One part of a user message's content: text, or an image/document fetched by URL. */
interface AiTextPart {
  type: "text";
  content: string;
}
export interface AiImagePart {
  type: "image";
  source: { type: "url"; value: string; mimeType?: string };
}
/** A document (e.g. a PDF receipt). Resolved the same way as an image — see
 * {@link resolveImageContent} — since pi-ai's `Message` has no document
 * content type; this is the one caller (the vision-batch/Gemini receipt
 * tier) that sends one, and Gemini accepts inline PDF bytes the same way it
 * accepts an inline image. */
interface AiDocumentPart {
  type: "document";
  source: { type: "url"; value: string; mimeType: string };
}
type AiContentPart = AiTextPart | AiImagePart | AiDocumentPart;
/** Every message `runStructuredFeature` sends is a single-turn user prompt —
 * no caller here carries a multi-turn conversation with prior assistant
 * turns, so this intentionally only models `role: "user"`. */
export interface AiMessage {
  role: "user";
  content: string | AiContentPart[];
}

/** Everything a `chat()` call needs that the feature record does not own:
 * the prompt itself. Request builders in `clients/ai.ts` return this. */
export interface AiChatRequest {
  systemPrompts: string[];
  messages: AiMessage[];
}

/** What one call site supplies about *this* call. */
export interface AiRunContext<T = unknown> {
  /**
   * Where the `AiUsage` row is written. Omit to run without usage accounting
   * (the eval harness and smoke paths that have no database).
   */
  db?: Database;
  /** Every AI call belongs to a run; see `ensureRun`. */
  runId: RunId;
  /** The code path placing the call — `suggestCategory`, `select`, … */
  operation: string;
  /** Correlates calls emitted while one durable job is executing. */
  job?: { kind: string; id: string } | null;
  entity?: { entityKind: string; entityId: string } | null;
  /** Whether the *caller's* own cache (AiAnalysis) hit, for the usage row. */
  cacheStatus?: "hit" | "miss" | "none";
  applicationCacheStatus?: ApplicationCacheStatus;
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

/** The call-site fields a usage row takes from an {@link AiRunContext}. */
type UsageCallContext = Pick<
  AiRunContext,
  "db" | "runId" | "operation" | "job" | "entity" | "cacheStatus"
>;

/** What one call did; the rest of the row comes from the feature and context. */
export interface FeatureUsageOutcome {
  durationMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCost?: number | null;
  attempt?: number;
  status?: "succeeded" | "failed";
  gatewayLogId?: string | null;
  /** Overrides the context's caller-cache status for this row. */
  cacheStatus?: "hit" | "miss" | "none";
  applicationCacheStatus?: ApplicationCacheStatus;
}

/**
 * The one writer of `AiUsage` rows. Every model call — chat-tier (from the
 * `AssistantMessage` pi-ai returns), Jev's raw gateway fetch, embeddings, and
 * an answer replayed from the caller's own cache (`AiAnalysis`) — goes
 * through this function or `recordApplicationCacheHit`, never
 * `recordAiUsage` directly: a second writer double-counts spend. Provider
 * comes from the model registry.
 */
export async function recordFeatureUsage(
  spec: Pick<AiFeature, "feature" | "model">,
  ctx: UsageCallContext,
  outcome: FeatureUsageOutcome,
): Promise<void> {
  if (!ctx.db) return;
  await recordAiUsage(ctx.db, {
    provider: providerFor(spec.model),
    model: spec.model,
    feature: spec.feature,
    operation: ctx.operation,
    runId: ctx.runId,
    jobKind: ctx.job?.kind ?? null,
    jobId: ctx.job?.id ?? null,
    entity: ctx.entity ?? null,
    inputTokens: outcome.inputTokens ?? null,
    outputTokens: outcome.outputTokens ?? null,
    estimatedCost: outcome.estimatedCost ?? null,
    attempt: outcome.attempt,
    status: outcome.status,
    gatewayLogId: outcome.gatewayLogId ?? null,
    durationMs: outcome.durationMs,
    cacheStatus: outcome.cacheStatus ?? ctx.cacheStatus ?? "none",
    applicationCacheStatus: outcome.applicationCacheStatus,
  });
}

/** A gateway-response-cache answer: no tokens, no cost, zero attempts. */
export function recordApplicationCacheHit(
  spec: Pick<AiFeature, "feature" | "model">,
  ctx: UsageCallContext,
  durationMs: number,
): Promise<void> {
  return recordFeatureUsage(spec, ctx, {
    durationMs,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    attempt: 0,
    applicationCacheStatus: "hit",
  });
}

/**
 * Everything the runner decides before it touches the network, separated out
 * so `run-feature.unit.test.ts` can assert the policy without faking a
 * provider.
 */
export interface StructuredRunPlan {
  model: SupportedChatModel;
  call: GatewayCallOptions;
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
    metadata.entityKind = ctx.entity.entityKind;
    metadata.entityId = ctx.entity.entityId;
  }

  return {
    model: spec.model,
    call: spec.cache
      ? cachedCall({ metadata, force: ctx.force })
      : { metadata, skipCache: true },
  };
}

/**
 * The provider options for an arbitrary model, routed by the registry. For
 * the eval harness, which runs one feature's prompt across every model —
 * features go through {@link runStructuredFeature} instead.
 */
export function modelOptionsFor(
  model: SupportedChatModel,
  args: { maxTokens: number; effort?: SharedEffort },
) {
  return chatCompletionOptionsFor(
    model,
    { maxTokens: args.maxTokens, effort: args.effort ?? "low" },
    RESPOND_TOOL_NAME,
  );
}

/** The one seam `run-feature.unit.test.ts` fakes: resolving a model and
 * placing one `complete()` call against it. */
export interface StructuredRunPorts {
  callTarget: (
    model: SupportedChatModel,
    call: GatewayCallOptions,
  ) => PiCallTarget;
}

const productionStructuredRunPorts: StructuredRunPorts = {
  callTarget: piCallTarget,
};

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
function buildRepairTurn<T>(issues: string[], previousOutput: T): AiMessage {
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

// ---------------------------------------------------------------------------
// Images: request builders carry a URL; pi-ai's `ImageContent` is base64
// only, so every image/document part is resolved to bytes right before the
// call.
// ---------------------------------------------------------------------------

/**
 * A generous cap under every provider's own per-image limit. Resolution
 * fetches the whole body into memory (base64 encoding needs the full
 * buffer), so an unbounded source could exhaust a Worker's memory on a
 * single call.
 */
const MAX_AI_IMAGE_BYTES = 20 * 1024 * 1024;

async function resolveImageContent(
  part: AiImagePart | AiDocumentPart,
): Promise<ImageContent> {
  const response = await fetchExternalResponse(part.source.value);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch AI ${part.type} input (HTTP ${response.status} ${response.statusText}): ${part.source.value}`,
    );
  }
  const rawContentType =
    part.source.mimeType ??
    response.headers.get("content-type") ??
    "application/octet-stream";
  const mimeType = part.source.mimeType
    ? rawContentType
    : (() => {
        try {
          return parseContentType(rawContentType).type;
        } catch {
          return "application/octet-stream";
        }
      })();
  const bytes = await readResponseWithLimit(response, MAX_AI_IMAGE_BYTES);
  return {
    type: "image",
    data: Buffer.from(bytes).toString("base64"),
    mimeType,
  };
}

/** `content is string` is the one shape `allowInTypeGuards` recognizes as a
 * type guard, so the `typeof` narrowing this needs lives in its own
 * predicate function rather than inline. */
function isTextOnlyContent(content: AiMessage["content"]): content is string {
  return typeof content === "string";
}

async function toPiMessages(
  messages: readonly AiMessage[],
): Promise<UserMessage[]> {
  const result: UserMessage[] = [];
  for (const message of messages) {
    if (isTextOnlyContent(message.content)) {
      result.push({
        role: "user",
        content: message.content,
        timestamp: Date.now(),
      });
      continue;
    }
    const content: (TextContent | ImageContent)[] = [];
    for (const part of message.content) {
      content.push(
        part.type === "text"
          ? { type: "text", text: part.content }
          : await resolveImageContent(part),
      );
    }
    result.push({ role: "user", content, timestamp: Date.now() });
  }
  return result;
}

// ---------------------------------------------------------------------------
// The forced `respond` tool: the feature's Zod schema, verbatim as its tool
// parameters. `constrainedSampling: {type: "json_schema", strict: "prefer"}`
// asks pi-ai itself to send it in each provider's strict dialect — pi-ai's
// `makeStrictJsonSchema` (`@earendil-works/pi-ai/api/constrained-sampling`)
// already does exactly the transform the removed TanStack OpenAI adapter
// used to hand-roll
// (every property required, an optional property's type widened with
// `null`, `additionalProperties: false`), with "prefer" falling back to a
// plain tool call when a provider can't honor it (e.g. the schema has a
// `$ref`, which strict mode rejects). This module still has to know which
// properties strict mode *would* widen, independent of whether a given call
// ends up strict: {@link stripSyntheticNulls} needs those paths to tell "the
// model omitted this" apart from "this field is genuinely nullable" in the
// answer that comes back. Memoized per schema since every feature's schema
// is a module-level singleton.
// ---------------------------------------------------------------------------

export const RESPOND_TOOL_NAME = "respond";

/**
 * The narrow subset of JSON Schema this module actually has to walk:
 * `$ref`/`$defs` resolution, the union keywords, array `items`, and object
 * `properties`/`required`. `z.toJSONSchema()`'s output carries many more
 * keywords (`description`, `enum`, `minLength`, …) that this never reads;
 * `looseObject` keeps them on the parsed value — unchanged — rather than
 * stripping them, since the parsed value is also the exact object handed to
 * the provider as the tool's `parameters`.
 */
interface AiJsonSchemaNode {
  $ref?: string;
  type?: string | string[];
  items?: AiJsonSchemaNode;
  properties?: Record<string, AiJsonSchemaNode>;
  required?: string[];
  anyOf?: AiJsonSchemaNode[];
  oneOf?: AiJsonSchemaNode[];
  allOf?: AiJsonSchemaNode[];
  $defs?: Record<string, AiJsonSchemaNode>;
}

const aiJsonSchemaNode: z.ZodType<AiJsonSchemaNode> = z.lazy(() =>
  z.looseObject({
    $ref: z.string().optional(),
    type: z.union([z.string(), z.array(z.string())]).optional(),
    items: aiJsonSchemaNode.optional(),
    properties: z.record(z.string(), aiJsonSchemaNode).optional(),
    required: z.array(z.string()).optional(),
    anyOf: z.array(aiJsonSchemaNode).optional(),
    oneOf: z.array(aiJsonSchemaNode).optional(),
    allOf: z.array(aiJsonSchemaNode).optional(),
    $defs: z.record(z.string(), aiJsonSchemaNode).optional(),
  }),
);

/** Strips the `#/$defs/<name>` prefix `z.toJSONSchema()` emits for a `$ref`. */
function jsonSchemaDefName(ref: string): string {
  return ref.replace(/^#\/\$defs\//, "");
}

/**
 * Records the dot/`[]`-path of every property pi-ai's strict mode would make
 * synthetically nullable (every optional, non-required property), without
 * mutating `schema` — pi-ai performs the actual strict transform at request
 * time from the original schema.
 */
function collectOptionalPaths(
  schema: AiJsonSchemaNode,
  path: string,
  optionalPaths: Set<string>,
  defs: Readonly<Record<string, AiJsonSchemaNode>>,
  seenRefs: Set<string>,
): void {
  if (schema.$ref !== undefined) {
    const name = jsonSchemaDefName(schema.$ref);
    if (seenRefs.has(name)) return;
    seenRefs.add(name);
    const target = defs[name];
    if (target)
      collectOptionalPaths(target, path, optionalPaths, defs, seenRefs);
    return;
  }
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    collectOptionalPaths(branch, path, optionalPaths, defs, seenRefs);
  }
  if (schema.items) {
    collectOptionalPaths(
      schema.items,
      `${path}[]`,
      optionalPaths,
      defs,
      seenRefs,
    );
  }
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    for (const [key, sub] of Object.entries(schema.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      if (!required.has(key)) optionalPaths.add(childPath);
      collectOptionalPaths(sub, childPath, optionalPaths, defs, seenRefs);
    }
  }
}

/** `value is JsonObject` is the one shape `allowInTypeGuards` recognizes as
 * a type guard, so the representation check this needs lives in its own
 * predicate function rather than an inline `typeof`. */
function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

/**
 * Undoes the stand-in strict mode sends a model for "omitted": deletes a key
 * whose value is `null` at a path {@link collectOptionalPaths} recorded as
 * optional-only, so `spec.schema.parse()` sees an absent optional field
 * rather than a `null` its own (un-widened) Zod shape would reject. A path
 * not in `optionalPaths` is left untouched — a genuinely nullable field
 * keeps its `null`.
 */
function stripSyntheticNulls(
  value: JsonValue,
  path: string,
  optionalPaths: ReadonlySet<string>,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) =>
      stripSyntheticNulls(item, `${path}[]`, optionalPaths),
    );
  }
  if (isJsonObject(value)) {
    const result: JsonObject = {};
    for (const [key, sub] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (sub === null && optionalPaths.has(childPath)) continue;
      result[key] = stripSyntheticNulls(sub, childPath, optionalPaths);
    }
    return result;
  }
  return value;
}

interface RespondTool {
  tool: Tool;
  optionalPaths: Set<string>;
}

const respondToolCache = new WeakMap<z.ZodType, RespondTool>();

function respondToolFor(schema: z.ZodType): RespondTool {
  const cached = respondToolCache.get(schema);
  if (cached) return cached;

  // Parsed at the boundary where the dynamically-generated schema becomes a
  // domain value this module actually walks; `$schema` (the generated
  // dialect marker) is the one key callers never want on the wire.
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema);
  const jsonSchema = aiJsonSchemaNode.parse(rest);
  const optionalPaths = new Set<string>();
  collectOptionalPaths(
    jsonSchema,
    "",
    optionalPaths,
    jsonSchema.$defs ?? {},
    new Set(),
  );

  const tool: Tool = {
    name: RESPOND_TOOL_NAME,
    description: "Return the final structured answer.",
    // Plain JSON Schema, not `Type.Unsafe(...)`: pi-ai `structuredClone`s
    // strict tool parameters, and TypeBox's wrapper carries a validator
    // function that cannot be cloned, which failed every structured call.
    // SAFETY: providers only serialize `parameters`; the runner validates
    // the answer with the feature's Zod schema, never with TypeBox, so a
    // plain JSON Schema object in this TypeBox-typed slot is harmless.
    parameters: jsonSchema as Tool["parameters"],
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  };
  const built: RespondTool = { tool, optionalPaths };
  respondToolCache.set(schema, built);
  return built;
}

/**
 * Place one call: resolve the model, force the `respond` tool, and parse its
 * arguments against `schema`. Throws on a non-`toolUse`/missing-call result
 * (including `stopReason: "error"`/`"aborted"`, which pi-ai never throws —
 * it reports them on the resolved message) so callers keep one error path.
 */
async function placeStructuredCall<T>(args: {
  ports: StructuredRunPorts;
  model: SupportedChatModel;
  call: GatewayCallOptions;
  request: AiChatRequest;
  schema: z.ZodType<T>;
  maxTokens: number;
  effort?: OpenAiEffort | AnthropicEffort;
}): Promise<{ value: T; message: AssistantMessage }> {
  const { tool, optionalPaths } = respondToolFor(args.schema);
  const target = args.ports.callTarget(args.model, args.call);
  const context: Context = {
    systemPrompt: args.request.systemPrompts.join("\n\n"),
    messages: await toPiMessages(args.request.messages),
    tools: [tool],
  };
  const options = chatCompletionOptionsFor(
    args.model,
    { maxTokens: args.maxTokens, effort: args.effort },
    tool.name,
  );
  const message = await target.complete(
    context,
    // SAFETY: `chatCompletionOptionsFor` returns the exact per-API option
    // shape for `target.model`'s API (it is routed off the same registry
    // row `piCallTarget` resolved `target.model` from); `ModelsApiStreamOptions<Api>`
    // is the untyped dispatch shape `models.complete()` itself declares.
    options as Parameters<PiCallTarget["complete"]>[1],
  );
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(
      message.errorMessage ??
        `AI request ended with stopReason "${message.stopReason}"`,
    );
  }
  const toolCall = message.content.find(
    (block): block is ToolCall =>
      block.type === "toolCall" && block.name === tool.name,
  );
  if (!toolCall) {
    throw new Error(
      `Expected a forced "${tool.name}" tool call but got stopReason "${message.stopReason}"`,
    );
  }
  const stripped = stripSyntheticNulls(toolCall.arguments, "", optionalPaths);
  return { value: args.schema.parse(stripped), message };
}

/**
 * Place one structured call for `spec`, record its usage row from the
 * `AssistantMessage`'s own usage, and parse the forced tool call's
 * arguments against `spec.schema`.
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
    callCtx: UsageCallContext & {
      applicationCacheStatus?: ApplicationCacheStatus;
    },
  ): Promise<T> => {
    let responseFailure: GatewayResponseFailure | undefined;
    const call: GatewayCallOptions = {
      ...plan.call,
      onErrorResponse: (failure) => {
        responseFailure = failure;
      },
    };
    const startedAt = performance.now();
    try {
      const { value, message } = await placeStructuredCall({
        ports,
        model: plan.model,
        call,
        request: callRequest,
        schema: spec.schema,
        maxTokens: spec.maxTokens,
        effort: spec.effort,
      });
      if (callCtx.db) {
        await recordFeatureUsage(spec, callCtx, {
          durationMs: Math.round(performance.now() - startedAt),
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          estimatedCost: message.usage.cost.total,
          applicationCacheStatus: callCtx.applicationCacheStatus,
        });
      }
      return value;
    } catch (error) {
      const model = getChatModelConfig(plan.model);
      throw wrapAiGatewayError(
        error,
        {
          model: plan.model,
          provider: model.provider,
          route: model.route,
          feature: spec.feature,
          operation: ctx.operation,
        },
        responseFailure,
      );
    }
  };

  const validate = (value: unknown): T => {
    const parsed = spec.schema.parse(value);
    const checked = ctx.validate?.(parsed);
    if (checked && !checked.ok)
      throw new Error(
        `Structured output for "${spec.feature}" is invalid: ${checked.issues.join("; ")}`,
      );
    return parsed;
  };
  const keyInput: AiResponseCacheKeyInput = {
    feature: spec.feature,
    model: spec.model,
    promptVersion: spec.promptVersion,
    tier: spec.tier,
    maxTokens: spec.maxTokens,
    request,
  };
  if (spec.effort !== undefined) keyInput.effort = spec.effort;
  return withAiResponseCache({
    enabled: spec.cache && ports === productionStructuredRunPorts,
    force: ctx.force,
    keyInput,
    validate,
    onHit: (durationMs) => recordApplicationCacheHit(spec, ctx, durationMs),
    compute: async (applicationCacheStatus) => {
      const callContext = { ...ctx, applicationCacheStatus };
      const firstResult = await placeCall(
        request,
        planStructuredRun(spec, callContext),
        callContext,
      );
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
      const repairCallContext = { ...callContext, force: true };
      const repairedResult = await placeCall(
        repairRequest,
        planStructuredRun(spec, repairCallContext),
        repairCallContext,
      );
      const repairValidation = ctx.validate(repairedResult);
      if (repairValidation.ok) return repairedResult;
      throw new Error(
        `Structured output for "${spec.feature}" is invalid after one repair attempt: ${repairValidation.issues.join("; ")}`,
      );
    },
  });
}

/**
 * Place one embedding call and record its usage row. The feature is a plain
 * `{feature, model}` because embedding callers name their own label (search
 * queries and entity refresh share the runner, not the label).
 */
export async function runEmbeddingFeature(
  spec: { feature: string; model: SupportedEmbeddingModel },
  args: {
    embed: () => Promise<{
      embeddings: { index: number; vector: number[] }[];
      usage?: { promptTokens?: number | null; totalTokens?: number | null };
    }>;
  },
  ctx: Omit<AiRunContext, "runId"> & { runId?: RunId },
) {
  const startedAt = performance.now();
  const result = await args.embed().catch((error: UnparsedError) => {
    throw wrapAiGatewayError(error, {
      model: spec.model,
      provider: providerFor(spec.model),
      route: "openai",
      feature: spec.feature,
      operation: ctx.operation,
    });
  });
  if (ctx.runId) {
    await recordFeatureUsage(
      spec,
      { ...ctx, runId: ctx.runId },
      {
        inputTokens:
          result.usage?.promptTokens ?? result.usage?.totalTokens ?? null,
        durationMs: Math.round(performance.now() - startedAt),
        cacheStatus: "none",
      },
    );
  }
  return result;
}
