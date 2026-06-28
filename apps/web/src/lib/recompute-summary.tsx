import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

function backgroundWorkLabel(s: MutationSideEffects): string {
  const queued = s.backgroundBatches.some(
    (batch) => batch.processor === "queue",
  );
  return queued ? "Queued background work" : "Processed background work";
}

function BatchLink({ batchId }: { batchId: string }) {
  return (
    <Link
      to="/background-jobs"
      search={{ batchId }}
      className="underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
    >
      {batchId.slice(0, 8)}
    </Link>
  );
}

/**
 * Human toast payload for a mutation's persisted background side-effects.
 * Detailed counts live on the Background Jobs page; toasts expose the linked
 * batch refs so the user can inspect the actual work.
 */
export const savedWithBackgroundWork = (
  s: MutationSideEffects,
  base = "Saved",
): ReactNode => {
  if (s.backgroundBatches.length === 0) return `${base}.`;

  return (
    <span>
      {base}. {backgroundWorkLabel(s)}:{" "}
      {s.backgroundBatches.map((batch, index) => (
        <span key={batch.id}>
          {index > 0 ? ", " : ""}
          <BatchLink batchId={batch.id} />
        </span>
      ))}
      .
    </span>
  );
};
