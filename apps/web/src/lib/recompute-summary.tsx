import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

function backgroundWorkVerb(s: MutationSideEffects): string {
  const queued = s.backgroundBatches.some(
    (batch) => batch.processor === "queue",
  );
  return queued ? "Queued" : "Processed";
}

/**
 * Human toast payload for a mutation's persisted background side-effects.
 * Detailed counts live on the Background Jobs page; the toast surfaces a single
 * link that opens that page scoped to exactly this mutation's batches (via the
 * plural `batchIds` search param) so the user can inspect each one.
 */
export const savedWithBackgroundWork = (
  s: MutationSideEffects,
  base = "Saved",
): ReactNode => {
  const batches = s.backgroundBatches;
  if (batches.length === 0) return `${base}.`;

  return (
    <span>
      {base}.{" "}
      <Link
        to="/background-jobs"
        search={{ batchIds: batches.map((batch) => batch.id) }}
        className="underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
      >
        {backgroundWorkVerb(s)} {batches.length} background{" "}
        {batches.length === 1 ? "task" : "tasks"}
      </Link>
      .
    </span>
  );
};
