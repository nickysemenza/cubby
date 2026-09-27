import { z } from "zod";

import {
  ledgerPartyShortcode,
  purchaseShortcode,
  vendorShortcode,
} from "./identifier-fields.js";

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
  searched: z.number().int().nonnegative(),
  reviewable: z.number().int().nonnegative(),
  after: z.string(),
  nextPageToken: z.string().nullable(),
});
export type VendorSearchMailOut = z.infer<typeof vendorSearchMailOut>;

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
});

export const orderMailReviewItem = z.object({
  messageId: z.string(),
  threadId: z.string().nullable(),
  sender: z.string(),
  subject: z.string(),
  receivedAt: z.iso.datetime(),
  ledgerPartyId: ledgerPartyShortcode,
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

export const purchaseOrderMailInput = z.object({
  purchaseId: purchaseShortcode,
});
