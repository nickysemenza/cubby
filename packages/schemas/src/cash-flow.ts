import { z } from "zod";

import { plainDate } from "./base-entity";
import { projectShortcode, spendingCategoryShortcode } from "./identifiers";
import { money, wholeCentAmount } from "./money";
import { projectStatusSchema } from "./project-fields";

export const cashFlowHorizonSchema = z.union([
  z.literal(6),
  z.literal(12),
  z.literal(24),
]);

export const cashFlowIrregularModeSchema = z.enum(["grouped", "separate"]);

/** A what-if money movement; held in URL state only, never stored. */
export const cashFlowScenarioSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    date: plainDate,
    amount: wholeCentAmount.positive(),
    direction: z.enum(["inflow", "outflow"]),
    recurrence: z.enum(["once", "monthly"]),
    until: plainDate.optional(),
  })
  .refine((scenario) => !scenario.until || scenario.until >= scenario.date, {
    path: ["until"],
    message: "until must be on or after date",
  });
export type CashFlowScenario = z.infer<typeof cashFlowScenarioSchema>;

export const CASH_FLOW_MAX_SCENARIOS = 20;

export const cashFlowProjectionInput = z.object({
  horizonMonths: cashFlowHorizonSchema.default(12),
  includeNotStarted: z.boolean().default(false),
  irregular: cashFlowIrregularModeSchema.default("grouped"),
  /** Root Spending Categories narrowing the baseline; omitted means all. */
  categoryIds: z.array(spendingCategoryShortcode).max(50).optional(),
  scenarios: z
    .array(cashFlowScenarioSchema)
    .max(CASH_FLOW_MAX_SCENARIOS)
    .default([]),
});
export type CashFlowProjectionInput = z.input<typeof cashFlowProjectionInput>;
export type CashFlowProjectionArgs = z.output<typeof cashFlowProjectionInput>;

const month = z.string().regex(/^\d{4}-\d{2}$/u, "expected YYYY-MM");
const ledgerFilter = z.record(z.string(), z.string());

/** The Irregular row's key in grouped mode. */
export const CASH_FLOW_IRREGULAR_KEY = "irregular";

export const cashFlowBaselineRow = z.object({
  /** Root SPC- code, `uncategorized`, `unclassified`, or `irregular`. */
  key: z.string(),
  label: z.string(),
  irregular: z.boolean(),
  /** Months of the trailing window with nonzero net spend. */
  activeMonths: z.number().int().nonnegative(),
  trailingTotal: money,
  /** Mean of the 12 months (trailing total ÷ 12). */
  monthly: money,
  /** Ledger search over this bucket's trailing window; null when grouped. */
  ledgerFilter: ledgerFilter.nullable(),
});
export type CashFlowBaselineRow = z.infer<typeof cashFlowBaselineRow>;

const projectRef = {
  id: projectShortcode,
  name: z.string(),
  status: projectStatusSchema,
  estimate: money,
  actual: money,
  committed: money,
  remaining: money,
  endDate: plainDate.nullable(),
};

export const cashFlowEnvelope = z.object({
  ...projectRef,
  /** Remaining spread over months after the horizon ends. */
  beyondHorizon: money,
});
export type CashFlowEnvelope = z.infer<typeof cashFlowEnvelope>;

export const cashFlowUnscheduled = z.object({
  ...projectRef,
});
export type CashFlowUnscheduled = z.infer<typeof cashFlowUnscheduled>;

export const cashFlowMonth = z.object({
  month,
  baseline: z.array(z.object({ key: z.string(), amount: money })),
  envelopes: z.array(z.object({ id: projectShortcode, amount: money })),
  committed: money,
  /** Part of `committed` dated before the current month. */
  committedOverdue: money,
  scenarioOutflow: money,
  scenarioInflow: money,
  outflow: money,
  /** scenarioInflow − outflow. */
  net: money,
});
export type CashFlowMonth = z.infer<typeof cashFlowMonth>;

/**
 * A forward monthly projection computed on read: a flat baseline from the
 * trailing 12 complete household months, project envelopes, committed
 * `future` Expenses, and URL-held scenarios. Nothing here is stored.
 */
export const cashFlowProjectionOut = z.object({
  currentMonth: month,
  baselineWindow: z.object({ from: plainDate, to: plainDate }),
  irregular: cashFlowIrregularModeSchema,
  baseline: z.array(cashFlowBaselineRow),
  envelopes: z.array(cashFlowEnvelope),
  months: z.array(cashFlowMonth),
  unscheduled: z.array(cashFlowUnscheduled),
  totals: z.object({
    baselineMonthly: money,
    horizonOutflow: money,
    horizonInflow: money,
    unscheduledTotal: money,
    /** Envelope remainder scheduled past the horizon. */
    beyondHorizon: money,
    /** Committed Expenses dated past the horizon. */
    committedBeyondHorizon: money,
    netAfterScenarios: money,
  }),
});
export type CashFlowProjectionOut = z.infer<typeof cashFlowProjectionOut>;
