import type { RunId } from "@cubby/schemas/identifiers";
import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import { getErrorMessage } from "@cubby/shared";
import type {
  GatewayResponseFailure,
  GatewayResponseInfo,
  GatewayResponseWire,
} from "@cubby/shared/ai/gateway-request";
import type { OpenAiEffort } from "@cubby/shared/ai/models";
import {
  getChatModelConfig,
  providerFor,
  supportedChatModelSchema,
  type SupportedChatModel,
  type SupportedEmbeddingModel,
} from "@cubby/shared/ai/models";
import { piTokenUsage } from "@cubby/shared/ai/pi-providers";
import type { AiAvoidedUsage, AiCostEvidence } from "@cubby/shared/ai/pricing";
import {
  fetchExternalResponse,
  readResponseWithLimit,
} from "@cubby/shared/external-fetch";
import { sha256Hex } from "@cubby/shared/sha256";
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
import { isTokenValid, parse as parseContentType } from "content-type";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import {
  chatCompletionOptionsFor,
  cachedCall,
  piCallTarget,
  type AnthropicEffort,
  type FundedCall,
  type PiCallTarget,
  type SharedEffort,
} from "~/server/ai/adapters";
import { withAiBudget, withFreeBudget } from "~/server/ai/budget";
import type { GatewayCallOptions, GatewayMetadata } from "~/server/ai/gateway";
import { wrapAiGatewayError } from "~/server/ai/gateway-error";
import { MODEL_FOR_TIER } from "~/server/ai/policy/feature-identity";
import type {
  AiChatFeature,
  AiFeature,
  AiStructuredFeature,
} from "~/server/ai/policy/features";
import {
  AiResponseCacheBatch,
  type AiResponseCacheKeyInput,
  type ApplicationCacheStatus,
  withAiResponseCache,
} from "~/server/ai/response-cache";
import { recordAiUsage } from "~/server/ai/usage";
import type { Database } from "~/server/db";
import { JobDeferredError } from "~/server/generic/jobs/errors";

import { isGatewayAdmissionWait } from "./gateway-egress-client";

/** One part of a user message's content: text, or an image/document fetched by URL. */
interface AiTextPart {
  type: "text";
  content: string;
}
export interface AiImagePart {
  type: "image";
  source:
    | { type: "url"; value: string; mimeType?: string }
    | { type: "inline"; value: string; mimeType: string };
}
/** A document (e.g. a PDF receipt). Resolved the same way as an image — see
 * {@link resolveImageContent} — since pi-ai's `Message` has no document
 * content type; the shared OpenAI provider (`@cubby/shared/ai/pi-providers`)
 * rewrites the resulting PDF image block into the Responses `input_file`. */
interface AiDocumentPart {
  type: "document";
  source: { type: "url" | "inline"; value: string; mimeType: string };
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
export interface AiRunContext<T = unknown> extends Pick<
  GatewayCallOptions,
  | "subscriptionRequired"
  | "subscriptionFallback"
  | "beforePaidRequest"
  | "beforeFreeRequest"
> {
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
  /**
   * Receives the model that produced the returned answer, which the funding
   * ladder may choose over the feature's declared model. A cache hit reports
   * the model that originally answered, so stored provenance survives later
   * ladder changes.
   */
  onAnswered?: (model: SupportedChatModel) => void;
}

interface Answered<T> {
  value: T;
  model: SupportedChatModel;
}
const answeredEntry = z.object({
  value: z.unknown(),
  model: supportedChatModelSchema,
});

/** The call-site fields a usage row takes from an {@link AiRunContext}. */
type UsageCallContext = Pick<
  AiRunContext,
  "db" | "runId" | "operation" | "job" | "entity" | "cacheStatus"
>;

/** What one call did; the rest of the row comes from the feature and context. */
export interface FeatureUsageOutcome {
  /** What carried the call; `cache` when an answer replayed without one. */
  transport: AiUsageTransport;
  durationMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  standardCost?: number | null;
  costEvidence?: AiCostEvidence | null;
  chargedCost?: number | null;
  attempt?: number;
  status?: "succeeded" | "failed";
  gatewayLogId?: string | null;
  gatewayCacheStatus?: GatewayResponseInfo["gatewayCacheStatus"];
  /** A failed call's provider refusal or error. */
  failure?: string;
  /** Overrides the context's caller-cache status for this row. */
  cacheStatus?: "hit" | "miss" | "none";
  applicationCacheStatus?: ApplicationCacheStatus;
  avoidedUsage?: AiAvoidedUsage | null;
}

/**
 * The usage row for a declared feature's call: chat-tier (from the
 * `AssistantMessage` pi-ai returns), the decision model's raw gateway fetch, embeddings, and
 * an answer replayed from the caller's own cache (`AiAnalysis`). Provider
 * comes from the model declaration. Calls outside a feature declaration (the
 * cookbook forwarder, audit recovery, the import agent) call `recordAiUsage`
 * directly; each call is still recorded by exactly one of them.
 */
function describeResponseFailure(failure: GatewayResponseFailure): string {
  return `HTTP ${failure.status} ${failure.statusText}: ${failure.body}`;
}

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
    cacheReadTokens: outcome.cacheReadTokens ?? null,
    cacheWriteTokens: outcome.cacheWriteTokens ?? null,
    standardCost: outcome.standardCost ?? null,
    costEvidence: outcome.costEvidence ?? null,
    chargedCost: outcome.chargedCost ?? null,
    attempt: outcome.attempt,
    status: outcome.status,
    gatewayLogId: outcome.gatewayLogId ?? null,
    gatewayCacheStatus: outcome.gatewayCacheStatus ?? null,
    failure: outcome.failure ?? null,
    durationMs: outcome.durationMs,
    cacheStatus: outcome.cacheStatus ?? ctx.cacheStatus ?? "none",
    applicationCacheStatus: outcome.applicationCacheStatus,
    transport: outcome.transport,
    avoidedUsage: outcome.avoidedUsage ?? null,
  });
}

/**
 * An application response-cache (`withAiResponseCache`) answer: no upstream
 * call, so transport `cache`, no tokens, zero charged cost and attempts. The
 * standard comparison prices the tokens the cached answer originally
 * consumed; an entry published without them leaves it unknown. A Gateway
 * response-cache hit is different — it still went through the gateway.
 */
export function recordApplicationCacheHit(
  spec: Pick<AiFeature, "feature" | "model">,
  ctx: UsageCallContext,
  durationMs: number,
  avoidedUsage: AiAvoidedUsage | null,
): Promise<void> {
  return recordFeatureUsage(spec, ctx, {
    transport: "cache",
    durationMs,
    inputTokens: 0,
    outputTokens: 0,
    applicationCacheStatus: "hit",
    avoidedUsage,
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
  /** Present: the household funding ladder answers (`fundedChatAttempts`). */
  funded?: Pick<FundedCall, "paid">;
}

export function planStructuredRun<T = unknown>(
  spec: Pick<
    AiChatFeature,
    "feature" | "model" | "tier" | "cache" | "collectPayload"
  >,
  ctx: AiRunContext<T>,
): StructuredRunPlan {
  const metadata: GatewayMetadata = {
    feature: spec.feature,
    operation: ctx.operation,
  };
  // The entity id stays in the usage ledger, never a gateway label.
  if (ctx.entity) metadata.entityKind = ctx.entity.entityKind;

  return {
    model: spec.model,
    // A tier's declared model rides the funding ladder; a pinned model (an
    // evaluation comparing models) stays fixed.
    ...(spec.model === MODEL_FOR_TIER[spec.tier] && {
      funded: {
        paid:
          !ctx.subscriptionRequired || ctx.subscriptionFallback === "budgeted",
      },
    }),
    call: {
      ...(spec.cache
        ? cachedCall({ metadata, force: ctx.force })
        : { metadata, skipCache: true }),
      collectPayload: spec.collectPayload,
      subscriptionRequired: ctx.subscriptionRequired,
      subscriptionFallback: ctx.subscriptionFallback,
      beforePaidRequest: withAiBudget(
        ctx.db,
        { model: spec.model, runId: ctx.runId },
        ctx.beforePaidRequest,
      ),
      beforeFreeRequest: withFreeBudget(
        ctx.db,
        { model: spec.model, runId: ctx.runId },
        ctx.beforeFreeRequest,
      ),
    },
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
    funded?: FundedCall,
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
  if (part.source.type === "inline") {
    if (
      part.source.value.length > Math.ceil(MAX_AI_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(part.source.value)
    )
      throw new Error(
        "Inline AI input exceeds the byte bound or is not base64.",
      );
    const bytes = Buffer.from(part.source.value, "base64");
    if (
      bytes.byteLength > MAX_AI_IMAGE_BYTES ||
      bytes.toString("base64") !== part.source.value
    )
      throw new Error(
        "Inline AI input exceeds the byte bound or has invalid base64 encoding.",
      );
    return {
      type: "image",
      data: part.source.value,
      mimeType: part.source.mimeType,
    };
  }
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
        // The parser is lenient; only forward a valid type/subtype to AI providers.
        const { type } = parseContentType(rawContentType);
        const separator = type.indexOf("/");
        return separator > 0 &&
          isTokenValid(type, 0, separator) &&
          isTokenValid(type, separator + 1)
          ? type
          : "application/octet-stream";
      })();
  const bytes = await readResponseWithLimit(response, MAX_AI_IMAGE_BYTES);
  return {
    type: "image",
    data: Buffer.from(bytes).toString("base64"),
    mimeType,
  };
}

/**
 * A request's media as the provider receives it (`sent`) and as the
 * application cache keys it (`keyed`). Our bucket's object keys are unique per
 * write, so their URL names the bytes. Any other URL can change behind the
 * same address: its bytes are fetched once, sent inline and keyed by digest.
 */
export async function identifyMedia(
  request: AiChatRequest,
): Promise<{ sent: AiChatRequest; keyed: AiChatRequest }> {
  const { isOurBucketUrl } = await import("~/server/clients/r2-public-url");
  const sent: AiMessage[] = [];
  const keyed: AiMessage[] = [];
  for (const message of request.messages) {
    if (isTextOnlyContent(message.content)) {
      sent.push(message);
      keyed.push(message);
      continue;
    }
    const sentParts: AiContentPart[] = [];
    const keyedParts: AiContentPart[] = [];
    for (const part of message.content) {
      if (
        part.type === "text" ||
        (part.source.type === "url" && isOurBucketUrl(part.source.value))
      ) {
        sentParts.push(part);
        keyedParts.push(part);
        continue;
      }
      const source =
        part.source.type === "inline"
          ? { value: part.source.value, mimeType: part.source.mimeType }
          : await resolveImageContent(part).then((content) => ({
              value: content.data,
              mimeType: content.mimeType,
            }));
      const inline = {
        ...part,
        source: { type: "inline" as const, ...source },
      };
      sentParts.push(inline);
      keyedParts.push({
        ...inline,
        source: {
          ...inline.source,
          value: `sha256:${await sha256Hex(source.value)}`,
        },
      });
    }
    sent.push({ ...message, content: sentParts });
    keyed.push({ ...message, content: keyedParts });
  }
  return {
    sent: { ...request, messages: sent },
    keyed: { ...request, messages: keyed },
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
 * The application-cache identity of one structured call: everything that
 * shapes the provider request. Provider options derive from the model,
 * `maxTokens` and `effort`; the respond tool carries the output schema.
 */
export function structuredCacheKeyInput(
  spec: Pick<
    AiStructuredFeature<unknown>,
    "feature" | "model" | "promptVersion" | "tier" | "maxTokens" | "effort"
  > & { schema: z.ZodType },
  request: AiChatRequest,
): AiResponseCacheKeyInput {
  const keyInput: AiResponseCacheKeyInput = {
    feature: spec.feature,
    model: spec.model,
    promptVersion: spec.promptVersion,
    tier: spec.tier,
    maxTokens: spec.maxTokens,
    outputSchema: respondToolFor(spec.schema).tool.parameters,
    request,
  };
  if (spec.effort !== undefined) keyInput.effort = spec.effort;
  return keyInput;
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
  funded?: FundedCall;
  request: AiChatRequest;
  schema: z.ZodType<T>;
  maxTokens: number;
  effort?: OpenAiEffort | AnthropicEffort;
  /** Receives the response before validation, which may still reject it. */
  onResponse: (message: AssistantMessage) => void;
}): Promise<{ value: T; message: AssistantMessage }> {
  const { tool, optionalPaths } = respondToolFor(args.schema);
  const target = args.ports.callTarget(args.model, args.call, args.funded);
  const context: Context = {
    // Claude thinking models take tool_choice "auto" (a forced choice 400s),
    // so the instruction carries the requirement.
    systemPrompt: [
      ...args.request.systemPrompts,
      `Give your final answer only by calling the ${tool.name} tool.`,
    ].join("\n\n"),
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
  args.onResponse(message);
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

/** A response's token classes and gateway verdict, as one usage outcome. */
function messageUsage(
  message: AssistantMessage,
  gateway: GatewayResponseInfo | undefined,
) {
  return {
    ...piTokenUsage(message),
    gatewayLogId: gateway?.gatewayLogId,
    gatewayCacheStatus: gateway?.gatewayCacheStatus,
  } satisfies Partial<FeatureUsageOutcome>;
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
  const { captureAiInput, preparingAiInputs } =
    await import("./evaluation-inputs");
  await captureAiInput(spec, ctx.operation, request);
  if (preparingAiInputs()) {
    if (spec.feature !== "selection-overflow")
      throw new Error("Only field selection supports input-only preparation");
    return spec.schema.parse({
      selectedId: null,
      confidence: "low",
      reasoning: "Input preparation",
    });
  }
  const placeCall = async (
    callRequest: AiChatRequest,
    plan: StructuredRunPlan,
    callCtx: UsageCallContext & {
      applicationCacheStatus?: ApplicationCacheStatus;
    },
    recordUsage: (usage: AiAvoidedUsage) => void,
  ): Promise<Answered<T>> => {
    let responseFailure: GatewayResponseFailure | undefined;
    const recoveredFailures: GatewayResponseFailure[] = [];
    // Unknown until the transport selects itself before the request leaves.
    let transport: AiUsageTransport = "unknown";
    let response: AssistantMessage | undefined;
    // pi-ai may retry inside one call; the last response is the answer's.
    let gateway: GatewayResponseInfo | undefined;
    let responseWire: GatewayResponseWire | undefined;
    const call: GatewayCallOptions = {
      ...plan.call,
      onErrorResponse: (failure) => {
        responseFailure = failure;
      },
      onRecoveredErrorResponse: (failure) => {
        recoveredFailures.push(failure);
        responseFailure = undefined;
        responseWire = undefined;
      },
      onResponse: (info, wire) => {
        gateway = info;
        responseWire = wire;
      },
      onTransport: (selected) => {
        transport = selected;
        responseWire = undefined;
      },
    };
    let startedAt = performance.now();
    // The funding ladder may answer with another model than the tier's.
    const answeredBy = (message: AssistantMessage | undefined) => {
      const answered = supportedChatModelSchema.safeParse(message?.model);
      return answered.success ? answered.data : plan.model;
    };
    const funded: FundedCall | undefined = plan.funded && {
      ...plan.funded,
      onRefusedAttempt: async (refused) => {
        const failure = responseFailure
          ? describeResponseFailure(responseFailure)
          : refused.errorMessage;
        if (responseFailure) recoveredFailures.push(responseFailure);
        responseFailure = undefined;
        responseWire = undefined;
        if (callCtx.db)
          await recordFeatureUsage(
            { ...spec, model: answeredBy(refused) },
            callCtx,
            {
              ...messageUsage(refused, gateway),
              transport,
              durationMs: Math.round(performance.now() - startedAt),
              status: "failed",
              failure,
              applicationCacheStatus: callCtx.applicationCacheStatus,
            },
          );
        // The next attempt selects its own transport; a refusal before it
        // does (paid admission) must not inherit this one's.
        gateway = undefined;
        transport = "unknown";
        startedAt = performance.now();
      },
    };
    try {
      const { value, message } = await placeStructuredCall({
        ports,
        model: plan.model,
        call,
        funded,
        request: callRequest,
        schema: spec.schema,
        maxTokens: spec.maxTokens,
        effort: spec.effort,
        onResponse: (message) => {
          response = message;
        },
      });
      const usage = messageUsage(message, gateway);
      recordUsage(usage);
      if (callCtx.db) {
        await recordFeatureUsage(
          { ...spec, model: answeredBy(message) },
          callCtx,
          {
            ...usage,
            transport,
            durationMs: Math.round(performance.now() - startedAt),
            applicationCacheStatus: callCtx.applicationCacheStatus,
          },
        );
      }
      return { value, model: answeredBy(message) };
    } catch (error) {
      // A failed call is still a call on its transport — a connected ChatGPT
      // plan's failure stays `chatgpt` even when no response ever arrived —
      // and a response the forced tool call or schema rejected was still
      // billed, so its usage stays on the row.
      if (!isGatewayAdmissionWait(error) || response || gateway)
        await recordFeatureUsage(
          { ...spec, model: answeredBy(response) },
          callCtx,
          {
            transport,
            durationMs: Math.round(performance.now() - startedAt),
            status: "failed",
            failure: responseFailure
              ? describeResponseFailure(responseFailure)
              : getErrorMessage(error),
            ...(response
              ? messageUsage(response, gateway)
              : {
                  gatewayLogId: gateway?.gatewayLogId,
                  gatewayCacheStatus: gateway?.gatewayCacheStatus,
                }),
            applicationCacheStatus: callCtx.applicationCacheStatus,
          },
        );
      const answered = answeredBy(response);
      const model = getChatModelConfig(answered);
      throw wrapAiGatewayError(
        error,
        {
          model: answered,
          provider: model.provider,
          route: model.gatewayProvider,
          feature: spec.feature,
          operation: ctx.operation,
          gatewayLogId: gateway?.gatewayLogId,
          recoveredFailures,
          responseWire,
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
  const cached = spec.cache && ports === productionStructuredRunPorts;
  const media = cached
    ? await identifyMedia(request)
    : { sent: request, keyed: request };
  let hitModel: SupportedChatModel | undefined;
  const answer = await withAiResponseCache<Answered<T>>({
    enabled: cached,
    force: ctx.force,
    keyInput: structuredCacheKeyInput(spec, media.keyed),
    // Entries carry their answering model; an older bare value fails this
    // parse and is recomputed once.
    validate: (cached) => {
      const entry = answeredEntry.parse(cached);
      hitModel = entry.model;
      return { value: validate(entry.value), model: entry.model };
    },
    // A replayed answer is booked under the model that originally produced it.
    onHit: (durationMs, avoidedUsage) =>
      recordApplicationCacheHit(
        { ...spec, model: hitModel ?? spec.model },
        ctx,
        durationMs,
        avoidedUsage,
      ),
    compute: async (applicationCacheStatus, recordUsage) => {
      const callContext = { ...ctx, applicationCacheStatus };
      const firstResult = await placeCall(
        media.sent,
        planStructuredRun(spec, callContext),
        callContext,
        recordUsage,
      );
      if (!ctx.validate) return firstResult;
      const firstValidation = ctx.validate(firstResult.value);
      if (firstValidation.ok) return firstResult;
      const repairRequest: AiChatRequest = {
        systemPrompts: media.sent.systemPrompts,
        messages: [
          ...media.sent.messages,
          buildRepairTurn(firstValidation.issues, firstResult.value),
        ],
      };
      const repairCallContext = { ...callContext, force: true };
      const repairedResult = await placeCall(
        repairRequest,
        planStructuredRun(spec, repairCallContext),
        repairCallContext,
        recordUsage,
      );
      const repairValidation = ctx.validate(repairedResult.value);
      if (repairValidation.ok) return repairedResult;
      throw new Error(
        `Structured output for "${spec.feature}" is invalid after one repair attempt: ${repairValidation.issues.join("; ")}`,
      );
    },
  });
  ctx.onAnswered?.(answer.model);
  return answer.value;
}

/** What an embedding call reports while its request is in flight. */
export type EmbeddingObservers = Required<
  Pick<GatewayCallOptions, "onTransport" | "onResponse">
>;

/** One provider request's vectors, in input order, and its prompt tokens. */
type PlacedEmbeddings = { vectors: number[][]; inputTokens: number | null };

/** The claimed misses of one finite text set, embedded by one request. */
class EmbeddingMisses {
  private observed = new Set<number>();
  private pending: {
    index: number;
    text: string;
    resolve(value: { vector: number[]; inputTokens: number | null }): void;
    reject(error: UnparsedError): void;
  }[] = [];

  constructor(
    private readonly count: number,
    private readonly place: (texts: string[]) => Promise<PlacedEmbeddings>,
  ) {}

  ready(index: number) {
    this.observed.add(index);
    if (this.observed.size === this.count) this.flush();
  }

  request(index: number, text: string) {
    return new Promise<{ vector: number[]; inputTokens: number | null }>(
      (resolve, reject) => {
        this.pending.push({ index, text, resolve, reject });
        this.ready(index);
      },
    );
  }

  private flush() {
    const entries = this.pending
      .splice(0)
      .sort((left, right) => left.index - right.index);
    if (!entries.length) return;
    void this.place(entries.map((entry) => entry.text)).then(
      ({ vectors, inputTokens }) => {
        // Each entry keeps its even share: what a later hit on it avoids.
        const share =
          inputTokens === null
            ? null
            : Math.round(inputTokens / entries.length);
        for (const [position, entry] of entries.entries())
          entry.resolve({ vector: vectors[position]!, inputTokens: share });
      },
      (error: UnparsedError) => {
        for (const entry of entries) entry.reject(error);
      },
    );
  }
}

/**
 * Embed `texts` through the application cache, one entry per distinct text.
 * The misses share one provider request with one usage row; each hit
 * records its own cache-hit row. The feature is a plain `{feature, model}`
 * because embedding callers name their own label (search queries and entity
 * refresh share the runner, not the label); entries are shared across labels.
 */
export async function runEmbeddingFeature(
  spec: { feature: string; model: SupportedEmbeddingModel },
  args: {
    texts: readonly string[];
    /** Requested vector length; part of every entry's identity. */
    dimensions: number;
    cache: boolean;
    /** Places one request for `texts`; the runner restores input order. */
    embed: (
      texts: string[],
      observers: EmbeddingObservers,
    ) => Promise<{
      embeddings: { index: number; vector: number[] }[];
      usage?: { promptTokens?: number | null; totalTokens?: number | null };
      costEvidence?: AiCostEvidence;
    }>;
  },
  ctx: Omit<AiRunContext, "runId"> & { runId?: RunId },
): Promise<number[][]> {
  const usageCtx = ctx.runId ? { ...ctx, runId: ctx.runId } : null;
  const texts = [...new Set(args.texts)];
  const vector = z
    .array(z.number().finite())
    .length(
      args.dimensions,
      `Embedding dimension mismatch: expected ${args.dimensions} values`,
    );
  const cache = new AiResponseCacheBatch(texts.length);
  const misses = new EmbeddingMisses(texts.length, async (batch) => {
    const placed = await placeEmbeddings(spec, args, ctx, usageCtx, batch);
    for (const placedVector of placed.vectors) vector.parse(placedVector);
    return placed;
  });
  // Settle every text before throwing: a sibling miss's paid vectors must be
  // stored before a Job defers on a busy key and its Worker ends.
  const settled = await Promise.allSettled(
    texts.map((text, index) =>
      withAiResponseCache({
        enabled: args.cache,
        batch: { batch: cache, index },
        force: ctx.force,
        keyInput: {
          feature: "embedding",
          model: spec.model,
          promptVersion: "1",
          embedding: { text, dimensions: args.dimensions },
        },
        validate: (value) => vector.parse(value),
        onWait: () => misses.ready(index),
        onHit: async (durationMs, avoided) => {
          misses.ready(index);
          if (usageCtx)
            await recordApplicationCacheHit(
              spec,
              usageCtx,
              durationMs,
              avoided,
            );
        },
        compute: async (_status, recordUsage) => {
          const miss = await misses.request(index, text);
          recordUsage({ inputTokens: miss.inputTokens, outputTokens: null });
          return miss.vector;
        },
      }).finally(() => {
        cache.ready(index);
        misses.ready(index);
      }),
    ),
  );
  const failures: UnparsedError[] = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    const deferred = failures.find(
      (error): error is JobDeferredError => error instanceof JobDeferredError,
    );
    if (deferred && deferred.cause == null)
      deferred.cause = failures.find(
        (error) => !(error instanceof JobDeferredError),
      );
    throw deferred ?? failures[0];
  }
  const vectors = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const byText = new Map(texts.map((text, index) => [text, vectors[index]!]));
  return args.texts.map((text) => byText.get(text)!);
}

/** Place one embedding request and record its usage row. */
async function placeEmbeddings(
  spec: { feature: string; model: SupportedEmbeddingModel },
  args: Parameters<typeof runEmbeddingFeature>[1],
  ctx: Parameters<typeof runEmbeddingFeature>[2],
  usageCtx: UsageCallContext | null,
  texts: string[],
): Promise<PlacedEmbeddings> {
  const startedAt = performance.now();
  let transport: AiUsageTransport = "unknown";
  let gateway: GatewayResponseInfo | undefined;
  let responseWire: GatewayResponseWire | undefined;
  const applicationCacheStatus = args.cache ? "miss" : "none";
  const result = await args
    .embed(texts, {
      onTransport: (selected) => {
        transport = selected;
        responseWire = undefined;
      },
      onResponse: (info, wire) => {
        gateway = info;
        responseWire = wire;
      },
    })
    .catch(async (error: UnparsedError) => {
      if (usageCtx && (!isGatewayAdmissionWait(error) || gateway))
        await recordFeatureUsage(spec, usageCtx, {
          transport,
          durationMs: Math.round(performance.now() - startedAt),
          status: "failed",
          cacheStatus: "none",
          gatewayLogId: gateway?.gatewayLogId,
          gatewayCacheStatus: gateway?.gatewayCacheStatus,
          applicationCacheStatus,
        });
      throw wrapAiGatewayError(error, {
        model: spec.model,
        provider: providerFor(spec.model),
        route: "openai",
        feature: spec.feature,
        operation: ctx.operation,
        gatewayLogId: gateway?.gatewayLogId,
        responseWire,
      });
    });
  const inputTokens =
    result.usage?.promptTokens ?? result.usage?.totalTokens ?? null;
  if (usageCtx) {
    await recordFeatureUsage(spec, usageCtx, {
      transport,
      inputTokens,
      costEvidence: result.costEvidence,
      durationMs: Math.round(performance.now() - startedAt),
      cacheStatus: "none",
      gatewayLogId: gateway?.gatewayLogId,
      gatewayCacheStatus: gateway?.gatewayCacheStatus,
      applicationCacheStatus,
    });
  }
  // Ordered by the reported input position, not by arrival. A batch caller
  // zips these against its own refs, so a reordered response would write
  // every vector onto the wrong entity — silently, and only detectably as
  // bad search results months later.
  const vectors = [...result.embeddings]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.vector);
  if (vectors.length !== texts.length)
    throw new Error(
      `Embedding response returned ${vectors.length} vectors for ${texts.length} inputs`,
    );
  return { vectors, inputTokens };
}
