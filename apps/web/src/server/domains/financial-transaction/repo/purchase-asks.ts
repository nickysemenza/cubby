import { STATEMENT_ANSWER_VERSIONS } from "@cubby/schemas/statement-answers";
import { z } from "zod";

import { defineAsk } from "~/server/kernel/api";

export const merchantIdentityAsk = defineAsk({
  feature: "merchant-identity",
  producer: "model",
  promptVersion: STATEMENT_ANSWER_VERSIONS.merchantIdentity,
  policy: { outputRevision: "merchant-identity.v1" },
  label: "the merchant identity",
  input: z.object({ merchant: z.string() }),
  output: z.object({
    name: z.string().nullable(),
    counterparty: z.string(),
    confidence: z.string(),
  }),
});
export const merchantSupportAsk = defineAsk({
  feature: "merchant-identity-support",
  producer: "model",
  promptVersion: STATEMENT_ANSWER_VERSIONS.merchantSupport,
  policy: { outputRevision: "merchant-identity-support.v1" },
  label: "support for the merchant identity",
  input: z.object({ merchant: z.string(), proposed: z.string() }),
  output: z.boolean(),
});
export const escrowAsk = defineAsk({
  feature: "loan-escrow-disbursement",
  producer: "model",
  promptVersion: STATEMENT_ANSWER_VERSIONS.escrow,
  policy: { outputRevision: "loan-escrow-disbursement.v1" },
  label: "the loan escrow movement",
  input: z.object({
    merchant: z.string().nullable(),
    description: z.string().nullable(),
    sourceCategory: z.string().nullable(),
    amount: z.number().finite(),
  }),
  output: z.boolean(),
});
