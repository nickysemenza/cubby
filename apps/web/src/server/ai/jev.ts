/**
 * The decision-tier runner: one closed-set choice placed with TypeSafe's
 * Jev over Workers AI. The chat-tier counterpart is `run-feature.ts`.
 */
import type { Confidence } from "@cubby/schemas/ai";
import { z } from "zod";

import { recordAiUsage } from "~/server/ai-usage";
import type { AiDecisionFeature } from "~/server/ai/features";
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
}

/**
 * The one seam tests fake: the model answer for an input, not the transport.
 * Production always runs the real transport, so a Jev failure throws instead
 * of answering from another model.
 */
export type JevPort = (input: JevChoiceInput) => Promise<JevChoiceResponse>;

// Jev's calibrated probability for the winning choice is bucketed into the
// public `confidence` here. TODO: expose the raw probability on the wire (a
// nullable field on the suggestion schemas) once the proposal UI has a place
// to show it.
function decisionConfidence(probability: number): Confidence {
  if (probability >= 0.85) return "high";
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
): Promise<JevChoiceResponse> {
  const metadata: GatewayMetadata = {
    feature: feature.feature,
    operation: ctx.operation,
  };
  if (ctx.entity) metadata.entityType = ctx.entity.entityType;
  const fetch = gatewayFetch(
    "workers-ai",
    feature.cache ? cachedCall({ metadata, force: ctx.force }) : { metadata },
  );

  const startedAt = performance.now();
  let parsed: JevChoiceResponse | undefined;
  try {
    const response = await fetch(
      `${gatewayBaseURL("workers-ai")}/run/${feature.model}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Jev request failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }
    parsed = parseJevResponse(await response.json().catch(() => undefined));
    return parsed;
  } finally {
    if (ctx.db) {
      await recordAiUsage(ctx.db, {
        provider: "typesafe",
        model: feature.model,
        feature: feature.feature,
        operation: ctx.operation,
        jobKind: ctx.job?.kind ?? null,
        jobId: ctx.job?.id ?? null,
        inputTokens: parsed?.usage?.input_tokens ?? null,
        outputTokens: parsed?.usage?.output_tokens ?? null,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        cacheStatus: ctx.cacheStatus ?? "none",
        entity: ctx.entity ?? null,
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

  const response = await (args.port
    ? args.port(input)
    : requestJev(input, args.usage, args.feature));
  const answer = response.answers.selection;
  validateProbabilities(answer.probabilities, new Set(Object.keys(criteria)));
  const selectedProbability = answer.probabilities[answer.choice];
  if (selectedProbability === undefined) {
    throw new Error("Jev selected a key absent from its probability map.");
  }
  const confidence = decisionConfidence(selectedProbability);

  if (answer.choice === NONE_KEY) {
    return {
      selectedIndex: null,
      confidence,
      probability: selectedProbability,
    };
  }
  const selectedIndex = Number(answer.choice.slice(1));
  if (
    !Number.isInteger(selectedIndex) ||
    selectedIndex >= args.choices.length
  ) {
    throw new Error("Jev selected an unknown candidate key.");
  }
  return { selectedIndex, confidence, probability: selectedProbability };
}
