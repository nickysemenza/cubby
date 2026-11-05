import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { useBulkStream } from "~/entity/hooks/use-bulk-stream";
import {
  ripple,
  rippleWithProblems,
  type InvalidationTagSet,
} from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import { Stack } from "~/ui/layout";
import { Progress } from "~/ui/primitives/progress";

import { PendingButton } from "./pending-button";

/**
 * Result-driven toast: which sonner variant to fire and with what message. The
 * message stays a ReactNode (rather than a plain string) so a result can be
 * phrased with inline emphasis, not because it links anywhere — there is no
 * batch page left to link a durable action's progress to.
 */
type BackfillToast = { tone: "success" | "info"; message: ReactNode };

export type BackfillButtonProps<TResult> = {
  disabled?: boolean;
  /** Opens the streaming workflow and forwards cancellation from the UI. */
  run: (
    signal: AbortSignal,
  ) => Promise<AsyncIterable<BulkProgressEvent<unknown, TResult>>>;
  /**
   * Cache tags to invalidate alongside the problems list. Spelled out here
   * rather than taken from the descriptor: these buttons drive a held-open
   * stream, so there is no `useMutation` for the root cache to read `meta` off.
   */
  invalidateTags?: InvalidationTagSet;
  toastResult: (data: TResult) => BackfillToast;
  idleLabel: string;
  pendingLabel: string;
  /**
   * True for actions that do all their work inside this single held-open stream
   * (no durable queue) — so the fragility is visible: while running we render a
   * "keep this page open" note, because navigating away / backgrounding the PWA /
   * hitting the Worker CPU limit kills the op with no record. Durable actions
   * (they enqueue jobs onto the queue and return once accepted) leave this off.
   */
  foreground?: boolean;
};

/** Starts a backfill's stream, then toasts and invalidates when it ends. */
export function useBackfill<TResult>({
  run,
  invalidateTags,
  toastResult,
}: Pick<
  BackfillButtonProps<TResult>,
  "run" | "invalidateTags" | "toastResult"
>) {
  const queryClient = useQueryClient();
  const { start, running, progress } = useBulkStream<unknown, TResult>();
  return {
    running,
    progress,
    start: () =>
      void start(run, {
        onDone: (data) => {
          const { tone, message } = toastResult(data);
          toast[tone](message);
          void invalidateOperationTags(
            queryClient,
            rippleWithProblems(invalidateTags ?? ripple.none),
          );
        },
      }),
  };
}

/**
 * A maintenance backfill's run button, driven entirely by props. The backfill
 * runs server-side in ONE streamed mutation (see `useBulkStream`); this
 * renders a live `<Progress>` bar beneath the button while it runs.
 */
export function BackfillButton<TResult>(
  props: BackfillButtonProps<TResult>,
): ReactNode {
  const { start, running, progress } = useBackfill(props);
  return (
    <Stack gap="xs">
      <PendingButton
        onClick={start}
        disabled={props.disabled}
        isPending={running}
        idleLabel={props.idleLabel}
        pendingLabel={props.pendingLabel}
      />
      {running && (
        <Progress
          value={progress?.done ?? 0}
          max={progress?.total ?? 1}
          indeterminate={!progress}
        />
      )}
      {running && props.foreground && (
        <span className="text-2xs text-warning-ink">
          Keep this page open — this runs here, not in the background.
        </span>
      )}
    </Stack>
  );
}
