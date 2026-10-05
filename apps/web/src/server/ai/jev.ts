/**
 * The decision-tier runner: one closed-set choice placed with Jev or Clef
 * over Workers AI. The chat-tier counterpart is `run-feature.ts`.
 */
import type { Confidence } from "@cubby/schemas/ai";
import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import { retryWithBackoff } from "@cubby/shared/retry";
import { z } from "zod";

import type { AiDecisionFeature } from "~/server/ai/features";
import {
  getDecisionModelConfig,
  providerFor,
  selectDecisionModel,
} from "~/server/ai/models";
import {
  type ApplicationCacheStatus,
  withAiResponseCache,
} from "~/server/ai/response-cache";
import {
  type AiRunContext,
  recordApplicationCacheHit,
  recordFeatureUsage,
} from "~/server/ai/run-feature";
import { cachedCall } from "~/server/clients/ai-adapters";
import {
  type GatewayMetadata,
  gatewayBaseURL,
  gatewayFetch,
} from "~/server/clients/ai-gateway";
import { wrapAiGatewayError } from "~/server/clients/ai-gateway-error";

/** Common trial bounds: Jev's 32k context, conservatively measured in bytes. */
const JEV_CONTEXT_BYTE_LIMIT = 32_000;
const JEV_MAX_CHOICES = 255;
/** One slot is reserved for `none`. */
export const JEV_MAX_CANDIDATES = JEV_MAX_CHOICES - 1;
const NONE_KEY = "none";
const JEV_MAX_ATTEMPTS = 3;
const JEV_DEADLINE_MS = 30_000;

function retryDelay(
  response: Response,
  attempt: number,
  elapsedMs: number,
): number | null {
  if (response.status !== 429 || attempt >= JEV_MAX_ATTEMPTS) return null;
  const header = response.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  const retryAfterMs = Number.isFinite(seconds)
    ? seconds * 1_000
    : header === null
      ? 0
      : Date.parse(header) - Date.now();
  // Spread a throttled table's retries out instead of replaying its burst.
  const backoff = 500 * 2 ** (attempt - 1) * (1 + Math.random());
  const delayMs = Math.max(
    backoff,
    Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
  );
  return elapsedMs + delayMs < JEV_DEADLINE_MS ? delayMs : null;
}

const jevChoiceInputSchema = z.object({
  state: z.string(),
  questions: z.object({
    selection: z.object({
      type: z.literal("choice"),
      instructions: z.string(),
      criteria: z.record(z.string(), z.string()),
    }),
  }),
});
type JevChoiceInput = z.infer<typeof jevChoiceInputSchema>;

const jevChoiceResponseSchema = z.object({
  answers: z.object({
    selection: z.object({
      type: z.literal("choice"),
      choice: z.string(),
      confidence: z.number().finite().min(0).max(1),
      probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
    }),
  }),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type JevChoiceResponse = z.infer<typeof jevChoiceResponseSchema>;

/**
 * Jev wraps its answer in `result`; Clef returns the answer directly.
 * Keep both wire shapes validated against the same choice contract.
 */
const jevGatewayEnvelopeSchema = z.object({ result: jevChoiceResponseSchema });
/**
 * The gateway-scoped run route (`AI.run` with `gateway.id`, REST `/ai/run`)
 * adds a run layer around Jev's answer: `{result: {state, result}, success,
 * errors}`. Only a `Completed` run carries an answer.
 */
const jevRunEnvelopeSchema = z.object({
  result: z.object({
    state: z.literal("Completed"),
    result: jevChoiceResponseSchema,
  }),
});

export interface JevChoiceResult {
  selectedIndex: number | null;
  confidence: Confidence;
  /** Jev's calibrated probability for the selected choice, before bucketing. */
  probability: number;
  /**
   * Every candidate's calibrated probability, desc by probability, `none`
   * excluded — the winner is `ranked[0]` (barring a probability tie). A
   * caller wanting runners-up filters out `selectedIndex` itself.
   */
  ranked: { index: number; probability: number }[];
}

/**
 * The one seam tests fake: the model answer for an input, not the transport.
 * Production always runs the real transport, so a model failure throws instead
 * of answering from another model.
 */
export type JevPort = (input: JevChoiceInput) => Promise<JevChoiceResponse>;

// Jev's calibrated probability for the winning choice is bucketed into the
// public `confidence` here. Exported so a caller that computes its own
// aggregate probability (e.g. the min across several prune-target removals)
// can bucket it the same way instead of re-deriving the thresholds.
/** The calibrated probability a decision needs to count as "high". */
export const HIGH_CONFIDENCE_PROBABILITY = 0.85;

export function decisionConfidence(probability: number): Confidence {
  if (probability >= HIGH_CONFIDENCE_PROBABILITY) return "high";
  if (probability >= 0.6) return "medium";
  return "low";
}

/** The answer in a successful response body, whichever wire shape carries it. */
function parseJevResponse(body: string): JevChoiceResponse {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    // SILENT: a non-JSON body fails every shape below and is quoted there.
    decoded = undefined;
  }
  const run = jevRunEnvelopeSchema.safeParse(decoded);
  if (run.success) return run.data.result.result;
  const enveloped = jevGatewayEnvelopeSchema.safeParse(decoded);
  if (enveloped.success) return enveloped.data.result;
  const direct = jevChoiceResponseSchema.safeParse(decoded);
  if (direct.success) return direct.data;
  // The raw body carries an unfinished run's state and the API's `errors`.
  throw new Error(
    `Decision model returned an invalid choice response. Body: ${body}`,
  );
}

async function requestJev(
  input: JevChoiceInput,
  ctx: AiRunContext,
  feature: AiDecisionFeature,
  applicationCacheStatus: ApplicationCacheStatus,
): Promise<JevChoiceResponse> {
  const metadata: GatewayMetadata = {
    feature: feature.feature,
    operation: ctx.operation,
  };
  if (ctx.entity) metadata.entityKind = ctx.entity.entityKind;
  let transport: AiUsageTransport = "unknown";
  const fetch = gatewayFetch("workers-ai", {
    ...(feature.cache
      ? cachedCall({ metadata, force: ctx.force })
      : { metadata }),
    onTransport: (selected) => {
      transport = selected;
    },
  });

  const startedAt = performance.now();
  const selector = getDecisionModelConfig(feature.model).selector;
  const requestBody = JSON.stringify(
    selector ? { ...input, model: selector } : input,
  );
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(
      new Error("Decision request exceeded its 30-second deadline."),
    );
  }, JEV_DEADLINE_MS);
  let parsed: JevChoiceResponse | undefined;
  let attempt = 0;
  let gatewayLogId: string | null = null;
  try {
    const { response, body } = await retryWithBackoff(
      async () => {
        attempt += 1;
        controller.signal.throwIfAborted();
        const attemptResponse = await fetch(
          `${gatewayBaseURL("workers-ai")}/run/${feature.model}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: requestBody,
            signal: controller.signal,
          },
        );
        gatewayLogId = attemptResponse.headers.get("cf-aig-log-id");
        return {
          response: attemptResponse,
          body: attemptResponse.ok
            ? ""
            : await attemptResponse.text().catch(() => ""),
        };
      },
      {
        signal: controller.signal,
        delayFor: (outcome) =>
          outcome.ok && !outcome.value.response.ok
            ? retryDelay(
                outcome.value.response,
                attempt,
                performance.now() - startedAt,
              )
            : null,
      },
    );
    if (!response.ok) {
      throw Object.assign(
        new Error(`Decision request failed (${response.status}): ${body}`),
        { status: response.status },
      );
    }
    parsed = parseJevResponse(await response.text().catch(() => ""));
    return parsed;
  } catch (error) {
    throw wrapAiGatewayError(error, {
      model: feature.model,
      provider: providerFor(feature.model),
      route: "workers-ai",
      feature: feature.feature,
      operation: ctx.operation,
      gatewayLogId,
    });
  } finally {
    clearTimeout(deadline);
    await recordFeatureUsage(feature, ctx, {
      transport,
      inputTokens: parsed?.usage?.input_tokens ?? null,
      outputTokens: parsed?.usage?.output_tokens ?? null,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      applicationCacheStatus,
      attempt,
      status: parsed ? "succeeded" : "failed",
      gatewayLogId,
    });
  }
}

function validateProbabilities(
  probabilities: Record<string, number>,
  expectedKeys: ReadonlySet<string>,
): void {
  const keys = Object.keys(probabilities);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => !expectedKeys.has(key))
  ) {
    throw new Error("Jev returned an unexpected probability key set.");
  }
  const total = keys.reduce((sum, key) => sum + probabilities[key]!, 0);
  if (Math.abs(total - 1) > 0.02) {
    throw new Error("Jev returned probabilities that do not normalize.");
  }
}

interface JevChoicePrompt {
  subject: string;
  rules: string;
  choices: readonly string[];
  allowNone?: boolean;
}

function buildChoiceInput(args: JevChoicePrompt): JevChoiceInput {
  const allowNone = args.allowNone ?? true;
  const criteria = Object.fromEntries(
    args.choices.map((label, index) => [`c${index}`, label]),
  );
  if (allowNone) criteria[NONE_KEY] = "No listed choice is a suitable match.";
  return {
    state: args.subject,
    questions: {
      selection: {
        type: "choice",
        instructions: allowNone
          ? `${args.rules}\nChoose exactly one option. Use none when no option fits.`
          : `${args.rules}\nChoose exactly one option.`,
        criteria,
      },
    },
  };
}

function inputFitsContext(input: JevChoiceInput): boolean {
  // UTF-8 bytes include JSON escaping and the complete request envelope.
  return (
    new TextEncoder().encode(JSON.stringify(input)).byteLength <=
    JEV_CONTEXT_BYTE_LIMIT
  );
}

/** Decide overflow before requesting Jev, using the same envelope as the transport. */
export function jevChoiceFitsContext(args: JevChoicePrompt): boolean {
  return (
    args.choices.length <= JEV_MAX_CANDIDATES &&
    inputFitsContext(buildChoiceInput(args))
  );
}

/**
 * One closed-set choice: Jev picks over `c0…cn` (plus `none` unless the
 * vocabulary is exhaustive), and the winner's index maps back to the
 * caller's roster. An oversized roster or input throws rather than being
 * silently truncated here; `runAiSelection` routes choices exceeding either
 * the candidate count or serialized byte budget to its overflow feature.
 */
export async function runJevChoice(args: {
  feature: AiDecisionFeature;
  subject: string;
  rules: string;
  /** One label per option, in roster order; at least one. */
  choices: readonly string[];
  usage: AiRunContext;
  /**
   * Offer a `none` choice. Default true; false for an exhaustive vocabulary
   * (every product has a category), where "none" would be an invalid value.
   */
  allowNone?: boolean;
  port?: JevPort;
}): Promise<JevChoiceResult> {
  if (args.choices.length > JEV_MAX_CANDIDATES) {
    throw new Error(
      `Jev supports at most ${JEV_MAX_CANDIDATES} choices, got ${args.choices.length}.`,
    );
  }

  const input = buildChoiceInput(args);
  if (!inputFitsContext(input)) {
    throw new Error(
      `Jev choice input exceeds the ${JEV_CONTEXT_BYTE_LIMIT}-byte bound.`,
    );
  }

  const validate = (value: unknown): JevChoiceResult => {
    const result = z
      .object({
        selectedIndex: z.number().int().nonnegative().nullable(),
        confidence: z.enum(["low", "medium", "high"]),
        probability: z.number().finite().min(0).max(1),
        ranked: z.array(
          z.object({
            index: z.number().int().nonnegative(),
            probability: z.number().finite().min(0).max(1),
          }),
        ),
      })
      .parse(value);
    if (
      result.selectedIndex !== null &&
      result.selectedIndex >= args.choices.length
    ) {
      throw new Error("Jev cached an unknown candidate key.");
    }
    if (result.ranked.some(({ index }) => index >= args.choices.length)) {
      throw new Error("Jev cached an unknown ranked choice.");
    }
    return result;
  };
  // Pin the sampled model before cache lookup; retries and usage keep it.
  const feature = args.port
    ? args.feature
    : { ...args.feature, model: selectDecisionModel() };
  return withAiResponseCache({
    enabled: feature.cache && !args.port,
    force: args.usage.force,
    keyInput: {
      feature: feature.feature,
      model: feature.model,
      promptVersion: feature.promptVersion,
      input,
    },
    validate,
    onHit: (durationMs) =>
      recordApplicationCacheHit(feature, args.usage, durationMs),
    compute: async (applicationCacheStatus) => {
      const response = await (args.port
        ? args.port(input)
        : requestJev(input, args.usage, feature, applicationCacheStatus));
      const answer = response.answers.selection;
      validateProbabilities(
        answer.probabilities,
        new Set(Object.keys(input.questions.selection.criteria)),
      );
      const selectedProbability = answer.probabilities[answer.choice];
      if (selectedProbability === undefined) {
        throw new Error("Jev selected a key absent from its probability map.");
      }
      const confidence = decisionConfidence(selectedProbability);
      const ranked = Object.entries(answer.probabilities)
        .filter(([key]) => key !== NONE_KEY)
        .map(([key, probability]) => ({
          index: Number(key.slice(1)),
          probability,
        }))
        .sort((a, b) => b.probability - a.probability);
      if (answer.choice === NONE_KEY) {
        return {
          selectedIndex: null,
          confidence,
          probability: selectedProbability,
          ranked,
        };
      }
      const selectedIndex = Number(answer.choice.slice(1));
      if (
        !Number.isInteger(selectedIndex) ||
        selectedIndex >= args.choices.length
      ) {
        throw new Error("Jev selected an unknown candidate key.");
      }
      return {
        selectedIndex,
        confidence,
        probability: selectedProbability,
        ranked,
      };
    },
  });
}
