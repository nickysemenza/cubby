import { fieldValueOf } from "@cubby/schemas/field-envelope";

import { DetailAction } from "~/entity/entity-detail/detail-action-bar";
import { RunSentryAction } from "~/entity/entity-detail/report-slot";
import { NoneValue } from "~/ui/text/none-value";

import type { EntityDetailFieldRenderers } from "./index";

export const runDetailFields = {
  "run-ai-cost": (run) => ({
    value: (
      <span className="tabular-nums">
        {fieldValueOf(run.fields.chargedCostLabel)}
      </span>
    ),
  }),
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
