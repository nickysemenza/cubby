import { z } from "zod";

import {
  ledgerPartyId,
  productId,
  runEntityId,
  userId,
} from "./identifier-fields.js";

const microUSD = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const mailboxId = z.string().min(1);

export const executionAuthorizationOwner = z.strictObject({
  userId,
  ledgerPartyId,
});
export type ExecutionAuthorizationOwner = z.infer<
  typeof executionAuthorizationOwner
>;

/** Host-derived discovery lanes; a model query never expands an approval. */
export const executionAuthorizationRequestedScope = z.strictObject({
  mailboxId,
  discovery: z.enum(["targeted", "new_mail", "all_history"]),
});
export type ExecutionAuthorizationRequestedScope = z.infer<
  typeof executionAuthorizationRequestedScope
>;

const pilot = z.strictObject({
  kind: z.literal("pilot"),
  mailboxId,
  discovery: z.literal("targeted"),
  candidateLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  productLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const continuous = z.strictObject({
  kind: z.literal("continuous"),
  mailboxId,
  discovery: z.literal("new_mail"),
});
const backfill = z.strictObject({
  kind: z.literal("backfill"),
  mailboxId,
  discovery: z.literal("all_history"),
});

/** One immutable, member-approved root snapshot, stored only by the host. */
const executionAuthorizationSnapshot = z.strictObject({
  kind: z.literal("execution_authorization"),
  version: z.literal(1),
  owner: executionAuthorizationOwner,
  scope: z.discriminatedUnion("kind", [pilot, continuous, backfill]),
  meteredBudget: z.strictObject({
    period: z.enum(["lifetime", "utc_calendar_month"]),
    limitMicroUSD: microUSD,
  }),
  expiresAt: z.iso.datetime(),
});

const validateBudgetPeriod = (
  input: Pick<
    z.infer<typeof executionAuthorizationSnapshot>,
    "scope" | "meteredBudget"
  >,
  context: z.RefinementCtx,
) => {
  const expected =
    input.scope.kind === "continuous" ? "utc_calendar_month" : "lifetime";
  if (input.meteredBudget.period !== expected)
    context.addIssue({
      code: "custom",
      path: ["meteredBudget", "period"],
      message: `This approval scope requires a ${expected} metered budget.`,
    });
};

export const executionAuthorizationInput =
  executionAuthorizationSnapshot.superRefine(validateBudgetPeriod);
export type ExecutionAuthorizationInput = z.infer<
  typeof executionAuthorizationInput
>;

/** Human request: the authenticated host supplies the immutable owner/version. */
export const executionAuthorizationApprovalInput =
  executionAuthorizationSnapshot
    .omit({ kind: true, version: true, owner: true })
    .superRefine(validateBudgetPeriod);

/** Authority is independent of causal parent or retry predecessor lineage. */
export const executionAuthorizationRef = z.strictObject({
  runId: runEntityId,
  approvalFingerprint: fingerprint,
});
export type ExecutionAuthorizationRef = z.infer<
  typeof executionAuthorizationRef
>;

export const executionAuthorizationClaim = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("candidate"),
    mailboxId,
    messageId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("product"), productId }),
]);
export type ExecutionAuthorizationClaim = z.infer<
  typeof executionAuthorizationClaim
>;

/** Completed private RunOperation receipts never refund a physical attempt. */
export const executionAuthorizationReceipt = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("metered_reservation"),
    approvalFingerprint: fingerprint,
    physicalAttemptId: z.uuid(),
    requestedScope: executionAuthorizationRequestedScope,
    periodKey: z.string().regex(/^(?:lifetime|\d{4}-(?:0[1-9]|1[0-2]))$/u),
    reservedMicroUSD: microUSD.positive(),
    reservedAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal("claim"),
    approvalFingerprint: fingerprint,
    claim: executionAuthorizationClaim,
    claimedAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal("revocation"),
    approvalFingerprint: fingerprint,
    revokedAt: z.iso.datetime(),
  }),
]);
export type ExecutionAuthorizationReceipt = z.infer<
  typeof executionAuthorizationReceipt
>;

export const executionAuthorizationRequest = z.strictObject({
  ref: executionAuthorizationRef,
  owner: executionAuthorizationOwner,
  requestedScope: executionAuthorizationRequestedScope,
});
export type ExecutionAuthorizationRequest = z.infer<
  typeof executionAuthorizationRequest
>;

export const executionAuthorizationReservation =
  executionAuthorizationRequest.extend({
    physicalAttemptId: z.uuid(),
    reservationMicroUSD: microUSD.positive(),
  });
export type ExecutionAuthorizationReservation = z.infer<
  typeof executionAuthorizationReservation
>;

export const executionAuthorizationClaimRequest =
  executionAuthorizationRequest.extend({
    claim: executionAuthorizationClaim,
  });
export type ExecutionAuthorizationClaimRequest = z.infer<
  typeof executionAuthorizationClaimRequest
>;
