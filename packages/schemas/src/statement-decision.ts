import { shortcodeSchema } from "@cubby/shared";
import { z } from "zod";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
} from "./identifiers";
import { statementTransactionApplication } from "./statement-suggestion";

export const statementDecisionInput = z.strictObject({
  observationId: shortcodeSchema("sourceTransactionRecord"),
  accountId: financialAccountShortcode.optional(),
  application: statementTransactionApplication.omit({ kind: true }).extend({
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
