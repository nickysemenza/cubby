import { z } from "zod";
import { plainDate } from "./base-entity";

import {
  ledgerPartyId,
  productId,
  runEntityId,
  userId,
  vendorId,
  vendorShortcode,
} from "./identifier-fields.js";

const microUSD = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const mailboxId = z.string().min(1);
// Calendar days advertise a pattern on the wire, while retaining ISO day validation.
const calendarDate = plainDate.refine(
  (value) => z.iso.date().safeParse(value).success,
  "expected a valid calendar date",
);

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
  discovery: z.enum(["targeted", "new_mail", "all_history", "vendor_history"]),
  /** Only `vendor_history`: the approved Vendors this request reads. */
  vendorIds: z.array(vendorId).min(1).max(20).optional(),
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
/** Selected Vendors' history: only these frozen sender/domain searches inside the window. */
const vendorBackfill = z.strictObject({
  kind: z.literal("vendor_backfill"),
  mailboxId,
  discovery: z.literal("vendor_history"),
  vendors: z
    .array(
      z.strictObject({
        vendorId,
      }),
    )
    .min(1)
    .max(20)
    .refine(
      (vendors) =>
        new Set(vendors.map((vendor) => vendor.vendorId)).size ===
        vendors.length,
      "Approved Vendors must be distinct.",
    ),
  senderPolicy: z.literal("verified_at_first_start"),
  receivedAfter: calendarDate.nullable(),
  receivedBefore: calendarDate,
  candidateLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  productLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** One immutable, member-approved root snapshot, stored only by the host. */
const executionAuthorizationSnapshot = z.strictObject({
  kind: z.literal("execution_authorization"),
  version: z.literal(1),
  owner: executionAuthorizationOwner,
  scope: z.discriminatedUnion("kind", [
    pilot,
    continuous,
    backfill,
    vendorBackfill,
  ]),
  meteredBudget: z.strictObject({
    period: z.enum(["lifetime", "utc_calendar_month"]),
    limitMicroUSD: microUSD,
  }),
  expiresAt: z.iso.datetime(),
});

const validateBudgetPeriod = (
  input: {
    scope: {
      kind: z.infer<typeof executionAuthorizationSnapshot>["scope"]["kind"];
    };
    meteredBudget: z.infer<
      typeof executionAuthorizationSnapshot
    >["meteredBudget"];
  },
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
  if (
    input.scope.kind === "vendor_backfill" &&
    "receivedAfter" in input.scope &&
    "receivedBefore" in input.scope &&
    typeof input.scope.receivedAfter === "string" &&
    typeof input.scope.receivedBefore === "string" &&
    input.scope.receivedAfter >= input.scope.receivedBefore
  )
    context.addIssue({
      code: "custom",
      path: ["scope", "receivedBefore"],
      message: "History must end after its start date.",
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
    .extend({
      scope: z.discriminatedUnion("kind", [
        pilot,
        continuous,
        backfill,
        vendorBackfill.omit({ vendors: true }).extend({
          vendors: z
            .array(z.strictObject({ vendorId: vendorShortcode }))
            .min(1)
            .max(20)
            .refine(
              (vendors) =>
                new Set(vendors.map((vendor) => vendor.vendorId)).size ===
                vendors.length,
              "Approved Vendors must be distinct.",
            ),
        }),
      ]),
    })
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
