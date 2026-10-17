import {
  CASH_FLOW_MAX_SCENARIOS,
  cashFlowHorizonSchema,
  cashFlowIrregularModeSchema,
  type CashFlowProjectionInput,
  cashFlowScenarioSchema,
} from "@cubby/schemas/cash-flow";
import { spendingCategoryShortcode } from "@cubby/schemas/identifiers";
import { z } from "zod";

/** `/cash-flow` URL state. Scenarios live here only (decision 17). */
export const cashFlowSearchSchema = z.object({
  horizon: z.coerce
    .number()
    .pipe(cashFlowHorizonSchema)
    .optional()
    .catch(undefined),
  notStarted: z.boolean().optional().catch(undefined),
  irregular: cashFlowIrregularModeSchema.optional().catch(undefined),
  category: z
    .array(spendingCategoryShortcode)
    .max(50)
    .optional()
    .catch(undefined),
  scenarios: z
    .array(cashFlowScenarioSchema)
    .max(CASH_FLOW_MAX_SCENARIOS)
    .optional()
    .catch(undefined),
});
export type CashFlowSearch = z.infer<typeof cashFlowSearchSchema>;

export const cashFlowSearchDefaults = {
  horizon: undefined,
  notStarted: undefined,
  irregular: undefined,
  category: undefined,
  scenarios: undefined,
} as const;

export const cashFlowInputFromSearch = (
  search: CashFlowSearch,
): CashFlowProjectionInput => ({
  horizonMonths: search.horizon ?? 12,
  includeNotStarted: search.notStarted ?? false,
  irregular: search.irregular ?? "grouped",
  ...(search.category?.length ? { categoryIds: search.category } : {}),
  scenarios: search.scenarios ?? [],
});
