import { NoneValue } from "~/components/ui/none-value";
import { savedSentryEventId, sentryEventUrl } from "~/lib/error-diagnostics";

import type { EntityDetailFieldRenderers } from "./index";

export const runDetailFields = {
  "run-failure-details": (run) => {
    const error = run.dispatchError;
    if (!error) return { value: <NoneValue /> };
    const [summary] = error.split("\n", 1);
    const sentryEventId = savedSentryEventId(error);
    return {
      value: (
        <div className="w-full min-w-0 text-sm">
          <p
            data-testid="run-failure-preview"
            className="line-clamp-2 break-words"
          >
            {summary}
          </p>
          {sentryEventId ? (
            <a
              className="mt-1 inline-block text-primary hover:underline"
              href={sentryEventUrl(sentryEventId)}
              target="_blank"
              rel="noreferrer"
            >
              View in Sentry
            </a>
          ) : null}
        </div>
      ),
    };
  },
} satisfies EntityDetailFieldRenderers<"run">;
