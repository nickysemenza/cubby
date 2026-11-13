import { z } from "zod";

import { plainDate } from "./base-entity";
import {
  financialAccountShortcode,
  transactionImportShortcode,
} from "./identifiers";
import { sweepFieldTargets } from "./run-fields";

/** A Sweep as a member or agent asks for it: entity scopes by shortcode. */
export const sweepStartInput = z.strictObject({
  families: z
    .array(
      z.discriminatedUnion("family", [
        z.strictObject({
          family: z.literal("statement_transaction"),
          importId: transactionImportShortcode.optional(),
          accountIds: z.array(financialAccountShortcode).max(100).optional(),
          since: plainDate.optional(),
        }),
        z.strictObject({
          family: z.literal("field"),
          targets: sweepFieldTargets.optional(),
        }),
      ]),
    )
    .min(1)
    .max(2),
});
export type SweepStartInput = z.infer<typeof sweepStartInput>;
export const sweepEstimateOut = z.object({
  families: z.array(
    z.object({
      family: z.enum(["statement_transaction", "field"]),
      records: z.number().int().nonnegative(),
    }),
  ),
});
