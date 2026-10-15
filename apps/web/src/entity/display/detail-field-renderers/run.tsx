import { DetailAction } from "~/entity/entity-detail/detail-action-bar";
import { RunSentryAction } from "~/entity/entity-detail/report-slot";
import { NoneValue } from "~/ui/primitives/none-value";

import type { EntityDetailFieldRenderers } from "./index";

export const runDetailFields = {
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
