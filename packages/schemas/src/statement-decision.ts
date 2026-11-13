import { shortcodeSchema } from "@cubby/shared";
import { z } from "zod";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
} from "./identifiers";
import { financialTransactionKind } from "./financial-transaction-fields";
import { financialSpendingRequest } from "./financial-booking";

// These values address transaction columns rather than a separate enum vocabulary.
const transactionFields = ["amount", "postedDate", "status"] as const;

export const statementDecisionInput = z.strictObject({
  observationId: shortcodeSchema("sourceTransactionRecord"),
  accountId: financialAccountShortcode.optional(),
  application: z.strictObject({
    transactionId: financialTransactionShortcode.optional(),
    fields: z.array(z.enum(transactionFields)).default([]),
    kindOverride: financialTransactionKind.optional(),
    rejectedCandidateIds: z.array(financialTransactionShortcode).default([]),
    booking: financialSpendingRequest
      .omit({ transactionId: true, source: true, advice: true })
      .optional(),
    action: z.enum(["create", "attach", "supersede", "void", "book", "reject"]),
  }),
});
export type StatementDecisionInput = z.infer<typeof statementDecisionInput>;
export const statementDecisionOut = z.object({
  status: z.enum(["applied", "waiting", "rejected"]),
  transactionId: financialTransactionShortcode.nullable(),
  gaps: z.array(z.string()),
});
export type StatementDecisionOut = z.infer<typeof statementDecisionOut>;
