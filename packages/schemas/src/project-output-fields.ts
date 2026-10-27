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

const projectExpenseTotals = z.object({
  spent: money.describe(
    "SUM(cost) of live expenses — the blended net (actualSpent + committedSpent − credits), including planned + offsets",
  ),
  // The `spent` figure above blends three economically distinct quantities;
  // these split it so callers can show a true money-out "Actual" that matches
  // the detail hero / budget decomposition instead of the net blend.
  actualSpent: money.describe(
    "SUM(cost) where cost > 0 and not future — money already spent",
  ),
  committedSpent: money.describe(
    "SUM(cost) where cost > 0 and future — planned, not yet spent",
  ),
  credits: money.describe(
    "SUM(-cost) where cost < 0 — project credits, positive magnitude",
  ),
  expenseCount: z.number().int(),
  taskCount: z.number().int(),
  doneTaskCount: z.number().int(),
});

export const projectRollup = projectExpenseTotals.extend({
  subtree: projectExpenseTotals.extend({
    projectCount: z.number().int().describe("Live descendant project count"),
    costEstimate: moneyNullable.describe(
      "SUM of non-null costEstimates; null when the subtree has none",
    ),
  }),
});
export type ProjectRollup = z.infer<typeof projectRollup>;

/** Coherent authoritative fold published once for Project readers (ADR 0021). */
export const projectRollupResult = z.object({
  rollup: projectRollup,
  dateWindow: projectDateWindow,
  taskProgress: z.string(),
  ownContentDates: z.object({
    contentStart: plainDate.nullable(),
    contentEnd: plainDate.nullable(),
  }),
});
export type ProjectRollupResult = z.infer<typeof projectRollupResult>;
