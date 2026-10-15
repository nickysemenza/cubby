/**
 * The decision-tier runner: closed-set questions placed with Jev or Clef
 * over Workers AI. The chat-tier counterpart is `run-feature.ts`.
 */
import { type Confidence, decisionConfidence } from "@cubby/schemas/ai";
import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import {
  gatewayBaseURL,
  type GatewayResponseInfo,
} from "@cubby/shared/ai/gateway-request";
import {
  getDecisionModelConfig,
  providerFor,
  selectDecisionModel,
  type SupportedDecisionModel,
} from "@cubby/shared/ai/models";
import { retryWithBackoff } from "@cubby/shared/retry";
import { z } from "zod";

import { cachedCall } from "~/server/ai/adapters";
import type { AiDecisionFeature } from "~/server/ai/features";
import { type GatewayMetadata, gatewayFetch } from "~/server/ai/gateway";
import { wrapAiGatewayError } from "~/server/ai/gateway-error";
import {
  type ApplicationCacheStatus,
  withAiResponseCache,
} from "~/server/ai/response-cache";
import {
  type AiRunContext,
  recordApplicationCacheHit,
  recordFeatureUsage,
} from "~/server/ai/run-feature";

import {
  DECISION_CONTEXT_BYTE_LIMIT,
  DecisionRequestBatch,
  type DecisionQuestionsInput,
  type DecisionQuestionsResponse,
} from "./decision-request-batch";
import { captureAiInput, preparingAiInputs } from "./evaluation-inputs";
import { isGatewayAdmissionWait } from "./gateway-egress-client";

const DECISION_MAX_CHOICES = 255;
/** One slot is reserved for `none`. */
export const DECISION_MAX_CANDIDATES = DECISION_MAX_CHOICES - 1;
const NONE_KEY = "none";
const DECISION_MAX_ATTEMPTS = 3;
/** The decision model's whole budget for one choice, retries included; MCP model reads outlast it. */
export const DECISION_DEADLINE_MS = 30_000;

function retryDelay(
  response: Response,
  attempt: number,
  elapsedMs: number,
): number | null {
  if (response.status !== 429 || attempt >= DECISION_MAX_ATTEMPTS) return null;
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
  return elapsedMs + delayMs < DECISION_DEADLINE_MS ? delayMs : null;
}

/** Embedded-only Clef media. Dimensions, when known, are validated but not sent. */
const decisionImageSchema = z.union([
  z.string(),
  z.object({
    content_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z.string(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
]);
export type DecisionImage = z.infer<typeof decisionImageSchema>;
const MIB = 1024 * 1024;

function embeddedImages(images: readonly DecisionImage[]) {
  if (images.length > 4) throw new Error("Clef supports at most 4 images.");
  let totalBytes = 0;
  return images.map((value) => {
    const image = decisionImageSchema.parse(value);
    let base64: string;
    if (typeof image === "string") {
      const match = /^data:image\/(?:png|jpeg|webp);base64,(.*)$/i.exec(image);
      if (!match)
        throw new Error(
          "Clef images require embedded PNG, JPEG, or WebP data URLs.",
        );
      base64 = match[1]!;
    } else {
      base64 = image.base64;
      if ((image.width === undefined) !== (image.height === undefined)) {
        throw new Error("Clef image dimensions require both width and height.");
      }
      if (
        image.width !== undefined &&
        image.height !== undefined &&
        image.width * image.height > 16_000_000
      ) {
        throw new Error("Clef image exceeds 16 megapixels.");
      }
    }
    if (
      base64.length === 0 ||
      base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    ) {
      throw new Error("Clef image contains invalid base64.");
    }
    const bytes =
      (base64.length / 4) * 3 -
      (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    if (bytes > 4 * MIB) throw new Error("Clef image exceeds 4 MiB.");
    totalBytes += bytes;
    if (totalBytes > 8 * MIB)
      throw new Error("Clef images exceed 8 MiB total decoded bytes.");
    return typeof image === "string"
      ? image
      : { content_type: image.content_type, base64 };
  });
}

const decisionChoiceInputSchema = z.object({
  state: z.string(),
  images: z
    .array(
      z.union([
        z.string(),
        z.object({ content_type: z.string(), base64: z.string() }),
      ]),
    )
    .optional(),
  questions: z.object({
    selection: z.object({
      type: z.literal("choice"),
      instructions: z.string(),
      criteria: z.record(z.string(), z.string()),
    }),
  }),
});
type DecisionChoiceInput = z.infer<typeof decisionChoiceInputSchema>;

const decisionChoiceResponseSchema = z.object({
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
export type DecisionChoiceResponse = z.infer<
  typeof decisionChoiceResponseSchema
>;

export interface DecisionChoiceResult {
  selectedIndex: number | null;
  confidence: Confidence;
  /** The decision model's calibrated probability for the selected choice, before bucketing. */
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
export type DecisionPort = (
  input: DecisionChoiceInput,
) => Promise<DecisionChoiceResponse>;

/** The answer in a successful response body, whichever wire shape carries it. */
function parseDecisionResponse(
  body: string,
  input: DecisionQuestionsInput,
): DecisionQuestionsResponse {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    // SILENT: a non-JSON body fails every shape below and is quoted there.
    decoded = undefined;
  }
  const schema = z.object({
    answers: z.record(
      z.string(),
      decisionChoiceResponseSchema.shape.answers.shape.selection,
    ),
    usage: decisionChoiceResponseSchema.shape.usage,
  });
  const run = z
    .object({
      result: z.object({ state: z.literal("Completed"), result: schema }),
    })
    .safeParse(decoded);
  const enveloped = z.object({ result: schema }).safeParse(decoded);
  const direct = schema.safeParse(decoded);
  const result = run.success
    ? run.data.result.result
    : enveloped.success
      ? enveloped.data.result
      : direct.success
        ? direct.data
        : undefined;
  if (
    result &&
    Object.keys(result.answers).length ===
      Object.keys(input.questions).length &&
    Object.keys(input.questions).every((key) => result.answers[key])
  )
    return result;
  // The raw body carries an unfinished run's state and the API's `errors`.
  throw new Error(
    `Decision model returned an invalid choice response. Unexpected question set or answer. Body: ${body}`,
  );
}

async function requestDecision(
  input: DecisionQuestionsInput,
  ctx: AiRunContext,
  feature: AiDecisionFeature,
  applicationCacheStatus: ApplicationCacheStatus,
): Promise<DecisionQuestionsResponse> {
  const metadata: GatewayMetadata = {
    feature: feature.feature,
    operation: ctx.operation,
  };
  if (ctx.entity) metadata.entityKind = ctx.entity.entityKind;
  let transport: AiUsageTransport = "unknown";
  // The last attempt's response; a throttled retry replaces the earlier one.
  let gateway: GatewayResponseInfo | undefined;
  const fetch = gatewayFetch("workers-ai", {
    beforePaidRequest: ctx.beforePaidRequest,
    collectPayload: feature.collectPayload,
    ...(feature.cache
      ? cachedCall({ metadata, force: ctx.force })
      : { metadata, skipCache: true }),
    onTransport: (selected) => {
      transport = selected;
    },
    onResponse: (info) => {
      gateway = info;
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
  }, DECISION_DEADLINE_MS);
  let parsed: DecisionQuestionsResponse | undefined;
  let attempt = 0;
  let admissionWait = false;
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
    parsed = parseDecisionResponse(
      await response.text().catch(() => ""),
      input,
    );
    return parsed;
  } catch (error) {
    admissionWait = isGatewayAdmissionWait(error);
    throw wrapAiGatewayError(error, {
      model: feature.model,
      provider: providerFor(feature.model),
      route: "workers-ai",
      feature: feature.feature,
      operation: ctx.operation,
      gatewayLogId: gateway?.gatewayLogId,
    });
  } finally {
    clearTimeout(deadline);
    if (!admissionWait || gateway)
      await recordFeatureUsage(feature, ctx, {
        transport,
        inputTokens: parsed?.usage?.input_tokens ?? null,
        outputTokens: parsed?.usage?.output_tokens ?? null,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        applicationCacheStatus,
        attempt,
        status: parsed ? "succeeded" : "failed",
        gatewayLogId: gateway?.gatewayLogId,
        gatewayCacheStatus: gateway?.gatewayCacheStatus,
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
    throw new Error(
      "The decision model returned an unexpected probability key set.",
    );
  }
  const total = keys.reduce((sum, key) => sum + probabilities[key]!, 0);
  if (Math.abs(total - 1) > 0.02) {
    throw new Error(
      "The decision model returned probabilities that do not normalize.",
    );
  }
}

export interface DecisionChoicePrompt {
  subject: string;
  rules: string;
  choices: readonly string[];
  allowNone?: boolean;
  images?: readonly DecisionImage[];
}

/** The exact request body a choice sends; the Decisions catalog renders it. */
export function buildChoiceInput(
  args: DecisionChoicePrompt,
): DecisionChoiceInput {
  const allowNone = args.allowNone ?? true;
  const criteria = Object.fromEntries(
    args.choices.map((label, index) => [`c${index}`, label]),
  );
  if (allowNone) criteria[NONE_KEY] = "No listed choice is a suitable match.";
  return {
    state: args.subject,
    ...(args.images?.length ? { images: embeddedImages(args.images) } : {}),
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

function inputFitsContext(input: DecisionChoiceInput): boolean {
  // Media has its own decoded-byte and body limits; the text context bound stays unchanged.
  const { images: _images, ...textInput } = input;
  return (
    new TextEncoder().encode(JSON.stringify(textInput)).byteLength <=
    DECISION_CONTEXT_BYTE_LIMIT
  );
}

/** Decide overflow before requesting the decision model, using the same envelope as the transport. */
export function decisionChoiceFitsContext(args: DecisionChoicePrompt): boolean {
  return (
    args.choices.length <= DECISION_MAX_CANDIDATES &&
    inputFitsContext(buildChoiceInput(args))
  );
}

/**
 * One closed-set choice: the decision model picks over `c0…cn` (plus `none` unless the
 * vocabulary is exhaustive), and the winner's index maps back to the
 * caller's roster. An oversized roster or input throws rather than being
 * silently truncated here; `runAiSelection` routes choices exceeding either
 * the candidate count or serialized byte budget to its overflow feature.
 */
export async function runDecisionChoice(
  args: DecisionChoiceArgs,
): Promise<DecisionChoiceResult> {
  return runDecisionChoiceInternal(args);
}

export async function runDecisionChoices(
  args: readonly DecisionChoiceArgs[],
): Promise<DecisionChoiceResult[]> {
  const batch = new DecisionRequestBatch(args.length);
  const usages = new Map<AiRunContext, number>();
  return Promise.all(
    args.map((item, index) => {
      if (!usages.has(item.usage)) usages.set(item.usage, usages.size);
      return runDecisionChoiceInternal(item, {
        batch,
        index,
        usageGroup: usages.get(item.usage)!,
      }).finally(() => batch.ready(index));
    }),
  );
}

type DecisionChoiceArgs = {
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
  images?: readonly DecisionImage[];
  port?: DecisionPort;
  onTokenUsage?: (usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  }) => void;
  /** A long-lived Run may pin the sampled decision tier for reproducibility. */
  decisionModel?: SupportedDecisionModel;
};

async function runDecisionChoiceInternal(
  args: DecisionChoiceArgs,
  pending?: { batch: DecisionRequestBatch; index: number; usageGroup: number },
): Promise<DecisionChoiceResult> {
  if (args.choices.length > DECISION_MAX_CANDIDATES) {
    throw new Error(
      `The decision model supports at most ${DECISION_MAX_CANDIDATES} choices, got ${args.choices.length}.`,
    );
  }

  const input = buildChoiceInput(args);
  if (!inputFitsContext(input)) {
    throw new Error(
      `Decision choice input exceeds the ${DECISION_CONTEXT_BYTE_LIMIT}-byte bound.`,
    );
  }

  const validate = (value: unknown): DecisionChoiceResult => {
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
      throw new Error("The decision model cached an unknown candidate key.");
    }
    if (result.ranked.some(({ index }) => index >= args.choices.length)) {
      throw new Error("The decision model cached an unknown ranked choice.");
    }
    return result;
  };
  // Images require vision even when a text-only model was pinned. Text calls
  // retain their pinned model or sample once before cache/retry.
  const feature = input.images?.length
    ? { ...args.feature, model: selectDecisionModel({ vision: true }) }
    : args.decisionModel
      ? { ...args.feature, model: args.decisionModel }
      : args.port
        ? args.feature
        : { ...args.feature, model: selectDecisionModel() };
  await captureAiInput(feature, args.usage.operation, input);
  if (preparingAiInputs())
    return {
      selectedIndex: null,
      confidence: "low",
      probability: 0,
      ranked: [],
    };
  if (input.images?.length) {
    const selector = getDecisionModelConfig(feature.model).selector;
    const body = JSON.stringify({
      model: feature.model,
      input: { ...input, model: selector },
    });
    if (new TextEncoder().encode(body).byteLength > 13 * MIB) {
      throw new Error("Clef request body exceeds 13 MiB.");
    }
  }
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
    onWait: () => pending?.batch.ready(pending.index),
    onHit: (durationMs) => {
      pending?.batch.ready(pending.index);
      return recordApplicationCacheHit(feature, args.usage, durationMs);
    },
    compute: async (applicationCacheStatus) => {
      if (args.port || input.images?.length)
        pending?.batch.ready(pending.index);
      const response = await (args.port
        ? args.port(input)
        : pending && !input.images?.length
          ? pending.batch.request(
              pending.index,
              JSON.stringify([feature, pending.usageGroup]),
              input,
              (questions) =>
                requestDecision(
                  questions,
                  args.usage,
                  feature,
                  applicationCacheStatus,
                ),
            )
          : requestDecision(
              input,
              args.usage,
              feature,
              applicationCacheStatus,
            ));
      args.onTokenUsage?.({
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      });
      const answer = response.answers.selection;
      if (!answer)
        throw new Error("The decision model omitted the selection question.");
      validateProbabilities(
        answer.probabilities,
        new Set(Object.keys(input.questions.selection.criteria)),
      );
      const selectedProbability = answer.probabilities[answer.choice];
      if (selectedProbability === undefined) {
        throw new Error(
          "The decision model selected a key absent from its probability map.",
        );
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
        throw new Error(
          "The decision model selected an unknown candidate key.",
        );
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
