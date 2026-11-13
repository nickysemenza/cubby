/** The saved Answer shape shared by field producers and review readers. */
import { z } from "zod";

const proposalValue = z.object({
  /** The value as the column stores it (a reference's id). */
  value: z.union([z.string(), z.array(z.string())]),
  label: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const fieldAnswer = z.object({
  proposal: proposalValue
    .extend({ runnerUp: proposalValue.nullable() })
    .nullable(),
  /** Why there is or is not a proposal: `pick`, `none`, or a skip reason. */
  outcome: z.string(),
});
export type FieldAnswer = z.infer<typeof fieldAnswer>;
