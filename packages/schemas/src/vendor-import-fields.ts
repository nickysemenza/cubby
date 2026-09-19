import { z } from "zod";

export const vendorOrderEvidence = z.enum([
  "online_account",
  "receipt_only",
  "not_expected",
]);

export const vendorAgentHints = z.object({
  ordersListUrl: z.url().nullable().default(null),
  pagination: z.string().max(1_000).nullable().default(null),
  orderLinkPattern: z.string().max(1_000).nullable().default(null),
  notes: z.array(z.string().max(1_000)).max(50).default([]),
});

export const vendorDomainList = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u,
      )
      .meta({ mockValue: "example.com" }),
  )
  .max(50);

export const vendorEmailSenderList = z
  .array(z.email().trim().toLowerCase())
  .max(50);
