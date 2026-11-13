import type { statementEscrowInput } from "@cubby/schemas/statement-answers";
import { z } from "zod";

import {
  modelAskFor,
  modelOutput,
  structuredModelInput,
  type ModelInput,
  type ModelOutput,
} from "~/server/ai/model-asks";
import {
  STATEMENT_TRANSACTION_KIND_FEATURE,
  STATEMENT_COUNTERPARTY_FEATURE,
  STATEMENT_CHARGE_IDENTITY_FEATURE,
  MERCHANT_IDENTITY_FEATURE,
  MERCHANT_IDENTITY_SUPPORT_FEATURE,
  LOAN_ESCROW_DISBURSEMENT_FEATURE,
} from "~/server/ai/policy/features";
import type { AiDecisionFeature } from "~/server/ai/policy/features";

const merchantIdentityAsk = modelAskFor(MERCHANT_IDENTITY_FEATURE);
const merchantSupportAsk = modelAskFor(MERCHANT_IDENTITY_SUPPORT_FEATURE);
const escrowAsk = modelAskFor(LOAN_ESCROW_DISBURSEMENT_FEATURE);

/** Freeze the complete prompt and transport parameters before hashing the Ask. */
const merchantIdentityRequest = (input: { merchant: string }): ModelInput =>
  structuredModelInput(
    MERCHANT_IDENTITY_FEATURE,
    MERCHANT_IDENTITY_FEATURE.request(input),
  );
function choiceRequest(
  feature: AiDecisionFeature & {
    prompt: (subject: string) => { subject: string; rules: string };
    choices: readonly string[];
  },
  input: string,
): ModelInput {
  const prompt = feature.prompt(input);
  return {
    kind: "choice",
    model: feature.model,
    subject: prompt.subject,
    rules: prompt.rules,
    choices: [...feature.choices],
    allowNone: false,
  };
}
function choiceAnswer(
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
function merchantAnswer(output: unknown) {
  const envelope = modelOutput.safeParse(output);
  const parsed = MERCHANT_IDENTITY_FEATURE.schema.safeParse(
    envelope.success ? envelope.data.value : null,
  );
  return parsed.success ? parsed.data : null;
}
const supportRequest = (input: { merchant: string; proposed: string }) =>
  choiceRequest(MERCHANT_IDENTITY_SUPPORT_FEATURE, JSON.stringify(input));
const escrowRequest = (
  input: NonNullable<ReturnType<typeof statementEscrowInput>>,
) => choiceRequest(LOAN_ESCROW_DISBURSEMENT_FEATURE, JSON.stringify(input));
const supportAnswer = (output: ModelOutput) =>
  choiceAnswer(output, MERCHANT_IDENTITY_SUPPORT_FEATURE.choices) ===
  "supported_business";
const escrowAnswer = (output: ModelOutput) =>
  choiceAnswer(output, LOAN_ESCROW_DISBURSEMENT_FEATURE.choices) ===
  "escrow_disbursement";

export const statementAsks = {
  statementKindAsk: modelAskFor(STATEMENT_TRANSACTION_KIND_FEATURE),
  counterpartyAsk: modelAskFor(STATEMENT_COUNTERPARTY_FEATURE),
  chargeIdentityAsk: modelAskFor(STATEMENT_CHARGE_IDENTITY_FEATURE),
  choiceRequest,
  choiceAnswer,
};
export const purchaseAsks = {
  merchantIdentityAsk,
  merchantIdentityRequest,
  merchantAnswer,
  supportRequest,
  supportAnswer,
  escrowRequest,
  escrowAnswer,
  merchantSupportAsk,
  escrowAsk,
};
