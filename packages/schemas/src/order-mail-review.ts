import { z } from "zod";

import { plainDate } from "./base-entity.js";
import {
  financialTransactionShortcode,
  ledgerPartyShortcode,
  purchaseShortcode,
  runShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "./identifier-fields.js";
import { chargeHuntOutcome, mailSearchPhase } from "./run-fields.js";

export const vendorOrderMailInput = z.object({
  vendorId: vendorShortcode,
  ledgerPartyId: ledgerPartyShortcode.nullable().optional(),
});

export const vendorSearchMailInput = z.object({
  vendorId: vendorShortcode,
  after: z
    .string()
    .regex(/^\d{4}\/\d{2}\/\d{2}$/u)
    .optional(),
  pageToken: z.string().min(1).max(2_000).optional(),
});

export const vendorSearchMailOut = z.object({
  runShortcode,
  status: mailSearchPhase,
  searched: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  reviewable: z.number().int().nonnegative(),
  after: z.string(),
  nextPageToken: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type VendorSearchMailOut = z.infer<typeof vendorSearchMailOut>;

export const vendorSearchMailStatusInput = z.object({
  vendorId: vendorShortcode,
});

export const orderMailDecisionInput = z.object({
  eventId: z.uuid(),
  purchaseId: purchaseShortcode,
  decision: z.enum(["linked", "dismissed"]),
  evidenceChecksum: z.string().min(1),
});

export const orderMailCandidate = z.object({
  purchaseId: purchaseShortcode,
  orderId: z.string().nullable(),
  statedTotal: z.number().nullable(),
  date: z.string().nullable(),
  reason: z.enum([
    "exact_order_id",
    "amount_and_date",
    "nearby_date",
    "previous_decision",
  ]),
  decision: z.enum(["linked", "dismissed"]).nullable(),
  evidenceChecksum: z.string().nullable(),
});

export const orderMailReviewItem = z.object({
  messageId: z.string(),
  threadId: z.string().nullable(),
  sender: z.string(),
  subject: z.string(),
  receivedAt: z.iso.datetime().nullable(),
  ledgerPartyId: ledgerPartyShortcode,
  researchRun: z
    .object({
      id: runShortcode,
      status: z.string(),
      sourceStatus: z.string(),
      evidenceChecksum: z.string(),
    })
    .nullable(),
  associations: z.array(
    z.object({
      purchaseId: purchaseShortcode,
      evidenceChecksum: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.uuid(),
      event: z.string(),
      orderId: z.string().nullable(),
      amount: z.number().nullable(),
      currency: z.string().nullable(),
      occurredAt: z.iso.datetime().nullable(),
      evidenceChecksum: z.string(),
      candidates: z.array(orderMailCandidate),
    }),
  ),
});
export const purchaseOrderMailOut = z.object({
  members: z.array(z.object({ id: ledgerPartyShortcode, name: z.string() })),
  items: z.array(orderMailReviewItem),
});
export type VendorOrderMailOut = z.infer<typeof purchaseOrderMailOut>;

export const orderMailDecisionOut = orderMailDecisionInput.pick({
  eventId: true,
  purchaseId: true,
  decision: true,
});

export const orderMailImportInput = orderMailDecisionInput.pick({
  eventId: true,
  evidenceChecksum: true,
});
export type OrderMailImportInput = z.infer<typeof orderMailImportInput>;
/** Related retained sources from one member and connected mailbox. */
export const orderMailImportSelectedInput = z.object({
  orders: z.array(orderMailImportInput).min(1).max(50),
});
export type OrderMailImportSelectedInput = z.infer<
  typeof orderMailImportSelectedInput
>;
export const orderMailImportOut = z.object({ runIds: z.array(runShortcode) });

export const purchaseOrderMailInput = z.object({
  purchaseId: purchaseShortcode,
});

/** One member's unallocated charges with a browser-searchable hunt on a Vendor account. */
export const vendorChargeHuntsInput = z.object({
  vendorAccountId: vendorAccountShortcode,
});
export type VendorChargeHuntsInput = z.infer<typeof vendorChargeHuntsInput>;
export const vendorChargeHuntsOut = z.object({
  items: z.array(
    z.object({
      transactionId: financialTransactionShortcode,
      merchant: z.string().nullable(),
      amount: z.number(),
      transactionDate: plainDate.nullable(),
      /** The hunt's state as stored; its meaning is `reason` when not selectable. */
      state: z.string(),
      /** Why this charge cannot be selected now; null when it can. */
      reason: z.string().nullable(),
      /** The unfinished run that owns this hunt, when one does. */
      runId: runShortcode.nullable(),
      /** Its outcome on that run. */
      outcome: chargeHuntOutcome.nullable(),
    }),
  ),
});
/** Charges of one Vendor account that one browser run should search for. */
export const chargeRunStartInput = z.object({
  vendorAccountId: vendorAccountShortcode,
  transactionIds: z.array(financialTransactionShortcode).min(1).max(50),
});
export type ChargeRunStartInput = z.infer<typeof chargeRunStartInput>;
export const chargeRunStartOut = z.object({ runId: runShortcode });
