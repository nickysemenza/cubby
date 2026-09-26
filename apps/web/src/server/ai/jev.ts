/**
 * The decision-tier runner: one closed-set choice placed with TypeSafe's
 * Jev over Workers AI. The chat-tier counterpart is `run-feature.ts`.
 */
import type { Confidence } from "@cubby/schemas/ai";
import { z } from "zod";

import { recordAiUsage } from "~/server/ai-usage";
import type { AiDecisionFeature } from "~/server/ai/features";
import {
  type ApplicationCacheStatus,
  withAiResponseCache,
} from "~/server/ai/response-cache";
import type { AiRunContext } from "~/server/ai/run-feature";
import { cachedCall } from "~/server/clients/ai-adapters";
import {
  type GatewayMetadata,
  gatewayBaseURL,
  gatewayFetch,
} from "~/server/clients/ai-gateway";

/** Jev's 32k context, applied to the request body's UTF-8 byte length. */
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

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
 * The gateway's Workers AI envelope (`{state, result, gatewayMetadata}`),
 * returned by the binding and the REST fallback alike — verified against the
 * live `workers-ai/run/typesafe/jev` route.
 */
const jevGatewayEnvelopeSchema = z.object({ result: jevChoiceResponseSchema });

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
 * Production always runs the real transport, so a Jev failure throws instead
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

function parseJevResponse(response: unknown): JevChoiceResponse {
  const enveloped = jevGatewayEnvelopeSchema.safeParse(response);
  if (enveloped.success) return enveloped.data.result;
  throw new Error("Jev returned an invalid choice response.");
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
  const fetch = gatewayFetch(
    "workers-ai",
    feature.cache ? cachedCall({ metadata, force: ctx.force }) : { metadata },
  );

  const startedAt = performance.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new Error("Jev request exceeded its 30-second deadline."));
  }, JEV_DEADLINE_MS);
  let parsed: JevChoiceResponse | undefined;
  let attempt = 0;
  let gatewayLogId: string | null = null;
  try {
    while (attempt < JEV_MAX_ATTEMPTS) {
      attempt += 1;
      controller.signal.throwIfAborted();
      const response = await fetch(
        `${gatewayBaseURL("workers-ai")}/run/${feature.model}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );
      gatewayLogId = response.headers.get("cf-aig-log-id");
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const delayMs = retryDelay(
          response,
          attempt,
          performance.now() - startedAt,
        );
        if (delayMs !== null) {
          await waitForRetry(delayMs, controller.signal);
          continue;
        }
        throw new Error(
          `Jev request failed (${response.status}): ${body.slice(0, 200)}`,
        );
      }
      parsed = parseJevResponse(await response.json().catch(() => undefined));
      return parsed;
    }
    throw new Error("Jev exhausted its request attempts.");
  } finally {
    clearTimeout(deadline);
    if (ctx.db) {
      await recordAiUsage(ctx.db, {
        provider: "typesafe",
        model: feature.model,
        feature: feature.feature,
        operation: ctx.operation,
        runId: ctx.runId,
        jobKind: ctx.job?.kind ?? null,
        jobId: ctx.job?.id ?? null,
        inputTokens: parsed?.usage?.input_tokens ?? null,
        outputTokens: parsed?.usage?.output_tokens ?? null,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        cacheStatus: ctx.cacheStatus ?? "none",
        applicationCacheStatus,
        entity: ctx.entity ?? null,
        attempt,
        status: parsed ? "succeeded" : "failed",
        gatewayLogId,
      });
    }
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

/**
 * One closed-set choice: Jev picks over `c0…cn` (plus `none` unless the
 * vocabulary is exhaustive), and the winner's index maps back to the
 * caller's roster. An oversized roster or input throws rather than being
 * silently truncated here; `runAiSelection` routes a roster beyond
 * {@link JEV_MAX_CANDIDATES} to its overflow feature before ever calling in.
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
  const allowNone = args.allowNone ?? true;
  if (args.choices.length > JEV_MAX_CANDIDATES) {
    throw new Error(
      `Jev supports at most ${JEV_MAX_CANDIDATES} choices, got ${args.choices.length}.`,
    );
  }

  const criteria = Object.fromEntries(
    args.choices.map((label, index) => [`c${index}`, label]),
  );
  if (allowNone) criteria[NONE_KEY] = "No listed choice is a suitable match.";
  const input: JevChoiceInput = {
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
  // UTF-8 bytes are a conservative, Unicode-safe upper bound on tokens.
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (bytes > JEV_CONTEXT_BYTE_LIMIT) {
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
  return withAiResponseCache({
    enabled: args.feature.cache && !args.port,
    force: args.usage.force,
    keyInput: {
      feature: args.feature.feature,
      model: args.feature.model,
      promptVersion: args.feature.promptVersion,
      input,
    },
    validate,
    onHit: async (durationMs) => {
      if (!args.usage.db) return;
      await recordAiUsage(args.usage.db, {
        provider: "typesafe",
        model: args.feature.model,
        feature: args.feature.feature,
        operation: args.usage.operation,
        runId: args.usage.runId,
        jobKind: args.usage.job?.kind ?? null,
        jobId: args.usage.job?.id ?? null,
        entity: args.usage.entity ?? null,
        cacheStatus: args.usage.cacheStatus ?? "none",
        applicationCacheStatus: "hit",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        attempt: 0,
        durationMs,
      });
    },
    compute: async (applicationCacheStatus) => {
      const response = await (args.port
        ? args.port(input)
        : requestJev(input, args.usage, args.feature, applicationCacheStatus));
      const answer = response.answers.selection;
      validateProbabilities(
        answer.probabilities,
        new Set(Object.keys(criteria)),
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
