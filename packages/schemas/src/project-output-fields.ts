import { z } from "zod";
import { plainDate } from "./base-entity";
import { money, moneyNullable } from "./money";

export const projectDateSourceSchema = z.enum(["explicit", "derived", "none"]);
export type ProjectDateSource = z.infer<typeof projectDateSourceSchema>;

export const projectDateWindow = z.object({
  derivedStart: plainDate.nullable(),
  derivedEnd: plainDate.nullable(),
  effectiveStart: plainDate.nullable(),
  effectiveEnd: plainDate.nullable(),
  startSource: projectDateSourceSchema,
  endSource: projectDateSourceSchema,
});
export type ProjectDateWindow = z.infer<typeof projectDateWindow>;

export const projectRollup = z.object({
  spent: money,
  actualSpent: money,
  committedSpent: money,
  contributions: money,
  expenseCount: z.number().int(),
  taskCount: z.number().int(),
  doneTaskCount: z.number().int(),
  subtree: z.object({
    spent: money,
    actualSpent: money,
    committedSpent: money,
    contributions: money,
    expenseCount: z.number().int(),
    taskCount: z.number().int(),
    doneTaskCount: z.number().int(),
    projectCount: z.number().int().describe("Live descendant project count"),
    costEstimate: moneyNullable.describe(
      "SUM of non-null costEstimates; null when the subtree has none",
    ),
  }),
});
export type ProjectRollup = z.infer<typeof projectRollup>;
