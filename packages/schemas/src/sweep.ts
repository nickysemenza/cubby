import { z } from "zod";

import { plainDate } from "./base-entity";
import {
  financialAccountShortcode,
  transactionImportShortcode,
} from "./identifiers";
import { sweepFieldTargets } from "./run-fields";

/** A Sweep as a member or agent asks for it: entity scopes by shortcode. */
export const sweepStartInput = z.object({
  families: z
    .array(
      z.discriminatedUnion("family", [
        z.object({
          family: z.literal("transfer_pair"),
          accountIds: z.array(financialAccountShortcode).max(100).optional(),
          since: plainDate.optional(),
        }),
        z.object({
          family: z.literal("statement_transaction"),
          importId: transactionImportShortcode.optional(),
          accountIds: z.array(financialAccountShortcode).max(100).optional(),
          since: plainDate.optional(),
        }),
        z.object({
          family: z.literal("recommendation"),
          entityKinds: z.array(z.string().min(1)).max(20).optional(),
        }),
        z.object({
          family: z.literal("field"),
          targets: sweepFieldTargets.optional(),
        }),
      ]),
    )
    .min(1)
    .max(4),
});
export type SweepStartInput = z.infer<typeof sweepStartInput>;
export const sweepEstimateOut = z.object({
  families: z.array(
    z.object({
      family: z.enum([
        "statement_transaction",
        "recommendation",
        "field",
        "transfer_pair",
      ]),
      records: z.number().int().nonnegative(),
    }),
  ),
});
