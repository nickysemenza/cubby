import { z } from "zod";

import {
  modelAskFor,
  modelOutput,
  structuredModelInput,
  type ModelInput,
} from "~/server/ai/model-asks";
import {
  MERCHANT_IDENTITY_FEATURE,
  MERCHANT_IDENTITY_SUPPORT_FEATURE,
  LOAN_ESCROW_DISBURSEMENT_FEATURE,
} from "~/server/ai/policy/features";
import type { AiDecisionFeature } from "~/server/ai/policy/features";

export const merchantIdentityAsk = modelAskFor(MERCHANT_IDENTITY_FEATURE);
export const merchantSupportAsk = modelAskFor(
  MERCHANT_IDENTITY_SUPPORT_FEATURE,
);
export const escrowAsk = modelAskFor(LOAN_ESCROW_DISBURSEMENT_FEATURE);

/** Freeze the complete prompt and transport parameters before hashing the Ask. */
export const merchantIdentityRequest = (input: {
  merchant: string;
}): ModelInput =>
  structuredModelInput(
    MERCHANT_IDENTITY_FEATURE,
    MERCHANT_IDENTITY_FEATURE.request(input),
  );
export function choiceRequest(
  feature: AiDecisionFeature & {
    prompt: (subject: string) => { subject: string; rules: string };
    choices: readonly string[];
  },
  input: unknown,
): ModelInput {
  const prompt = feature.prompt(
    typeof input === "string" ? input : JSON.stringify(input),
  );
  return {
    kind: "choice",
    model: feature.model,
    subject: prompt.subject,
    rules: prompt.rules,
    choices: [...feature.choices],
    allowNone: false,
  };
}
export function choiceAnswer(
  output: unknown,
  choices: readonly string[],
): string | null {
  const envelope = modelOutput.safeParse(output);
  const result = z
    .object({
      selectedIndex: z.number().int().nonnegative().nullable(),
      confidence: z.string(),
    })
    .safeParse(envelope.success ? envelope.data.value : null);
  return result.success &&
    result.data.confidence === "high" &&
    result.data.selectedIndex !== null
    ? (choices[result.data.selectedIndex] ?? null)
    : null;
}
export function merchantAnswer(output: unknown) {
  const envelope = modelOutput.safeParse(output);
  const parsed = MERCHANT_IDENTITY_FEATURE.schema.safeParse(
    envelope.success ? envelope.data.value : null,
  );
  return parsed.success ? parsed.data : null;
}
export const supportRequest = (input: { merchant: string; proposed: string }) =>
  choiceRequest(MERCHANT_IDENTITY_SUPPORT_FEATURE, input);
export const escrowRequest = (input: unknown) =>
  choiceRequest(LOAN_ESCROW_DISBURSEMENT_FEATURE, input);
export const supportAnswer = (output: unknown) =>
  choiceAnswer(output, MERCHANT_IDENTITY_SUPPORT_FEATURE.choices) ===
  "supported_business";
export const escrowAnswer = (output: unknown) =>
  choiceAnswer(output, LOAN_ESCROW_DISBURSEMENT_FEATURE.choices) ===
  "escrow_disbursement";
