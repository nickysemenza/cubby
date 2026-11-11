import { fieldValueOf } from "@cubby/schemas/field-envelope";

import { DetailAction } from "~/entity/entity-detail/detail-action-bar";
import { RunSentryAction } from "~/entity/entity-detail/report-slot";
import { formatAiCost } from "~/lib/number-format";
import { NoneValue } from "~/ui/text/none-value";

import type { EntityDetailFieldRenderers } from "./index";

const OUTCOME_COUNT_LABEL = [
  ["imported", "Imported"],
  ["linked", "Linked"],
  ["unrelated", "Unrelated"],
  ["waiting", "Waiting"],
  ["needsResearch", "Needs research"],
  ["needsMember", "Needs you"],
] as const;

/** Known cost, then the calls with no price; a bare zero never stands for unpriced calls. */
export const runCostLabel = (cost: number, unpricedCalls: number): string => {
  if (unpricedCalls <= 0) return formatAiCost(cost);
  const unpriced = `${unpricedCalls} unpriced ${unpricedCalls === 1 ? "call" : "calls"}`;
  return cost > 0 ? `${formatAiCost(cost)} + ${unpriced}` : unpriced;
};

export const runDetailFields = {
  "run-ai-cost": (run) => ({
    value: (
      <span className="tabular-nums">
        {runCostLabel(
          fieldValueOf(run.fields.chargedCost) ?? 0,
          fieldValueOf(run.fields.chargedUnpricedCount) ?? 0,
        )}
      </span>
    ),
  }),
  "run-outcome-counts": (run) => {
    const counts = fieldValueOf(run.fields.outcomeCounts);
    if (!counts) return { value: <NoneValue /> };
    const shown = OUTCOME_COUNT_LABEL.filter(([key]) => counts[key] > 0);
    return {
      value: shown.length ? (
        <ul
          aria-label="Email outcomes"
          className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-sm"
        >
          {shown.map(([key, label]) => (
            <li key={key} className="whitespace-nowrap">
              <span className="font-medium tabular-nums">{counts[key]}</span>{" "}
              <span className="text-muted-foreground">{label}</span>
            </li>
          ))}
        </ul>
      ) : (
        "No Email outcomes yet"
      ),
    };
  },
  "run-failure-details": (run) => {
    const error = run.dispatchError;
    if (!error) return { value: <NoneValue /> };
    const [summary] = error.split("\n", 1);
    return {
      value: (
        <div className="w-full min-w-0 text-sm">
          <p
            data-testid="run-failure-preview"
            className="line-clamp-2 break-words"
          >
            {summary}
          </p>
          <DetailAction>
            <RunSentryAction error={error} />
          </DetailAction>
        </div>
      ),
    };
  },
} satisfies EntityDetailFieldRenderers<"run">;
