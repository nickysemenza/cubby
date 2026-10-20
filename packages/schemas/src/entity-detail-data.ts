import { z } from "zod";

import { entitySchema } from "./entity-core";
import { entityGraphRootSchema } from "./entity-graph";

export const monthlyExpenseSpendInputSchema = z
  .object({ source: entityGraphRootSchema })
  .strict();
export const monthlyExpenseSpendOutputSchema = z.array(
  z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    cents: z.number().int(),
  }),
);
export const detailActivityInputSchema = z
  .object({
    source: entityGraphRootSchema,
    entity: entitySchema.optional(),
    limit: z.number().int().min(1).max(100).optional().default(30),
    cursor: z.string().optional(),
  })
  .strict();
export const detailActivityEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["record", "change"]),
  entity: entitySchema,
  shortcode: z.string().optional(),
  title: z.string(),
  subtitle: z.string().optional(),
  date: z.string().datetime(),
  /** Present only for Expense records; dollars converted to integer cents. */
  amountCents: z.number().int().optional(),
});
export const detailActivityOutputSchema = z.object({
  items: z.array(detailActivityEventSchema),
  nextCursor: z.string().nullable(),
});
export type MonthlyExpenseSpendInput = z.input<
  typeof monthlyExpenseSpendInputSchema
>;
export type MonthlyExpenseSpend = z.output<
  typeof monthlyExpenseSpendOutputSchema
>;
export type DetailActivityInput = z.input<typeof detailActivityInputSchema>;
export type DetailActivityEvent = z.output<typeof detailActivityEventSchema>;
export type DetailActivityPage = z.output<typeof detailActivityOutputSchema>;
