import { NoneValue } from "~/components/ui/none-value";

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
          <details className="mt-1 min-w-0">
            <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">
              Show full failure
            </summary>
            <pre
              data-testid="run-failure-full"
              className="mt-2 max-h-80 max-w-full overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs break-words whitespace-pre-wrap"
            >
              {error}
            </pre>
          </details>
        </div>
      ),
    };
  },
} satisfies EntityDetailFieldRenderers<"run">;
