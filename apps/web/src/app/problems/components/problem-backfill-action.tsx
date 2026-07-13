import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { Stack } from "~/components/layout";
import { Progress } from "~/components/ui/progress";
import { useTRPC, useTRPCClient } from "~/integrations/trpc/react";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import {
  invalidateTRPCQueries,
  problemsMutationInvalidateKeys,
} from "~/lib/query-keys";
import { ProblemActionButton } from "./problem-action-button";

type TRPCApi = ReturnType<typeof useTRPC>;
type TRPCClient = ReturnType<typeof useTRPCClient>;

/**
 * Result-driven toast: which sonner variant to fire and with what message. The
 * message is a ReactNode so a durable action can surface a `<Link>` to
 * `/background-jobs` (like other queued flows), not just plain text.
 */
type BackfillToast = { tone: "success" | "info"; message: ReactNode };

export type BackfillButtonProps<TResult> = {
  /** Opens the streaming backfill mutation, e.g. `(client) => client.problems.reparseStale.mutate()`. */
  run: (
    client: TRPCClient,
  ) => Promise<AsyncIterable<BulkProgressEvent<unknown, TResult>>>;
  /** Entity lists to invalidate alongside the problems list. */
  invalidateKeys?: (api: TRPCApi) => QueryKey[];
  toastResult: (data: TResult) => BackfillToast;
  idleLabel: string;
  pendingLabel: string;
  /**
   * True for actions that do all their work inside this single held-open stream
   * (no durable queue) — so the fragility is visible: while running we render a
   * "keep this page open" note, because navigating away / backgrounding the PWA /
   * hitting the Worker CPU limit kills the op with no record. Durable actions
   * (they enqueue jobs and return a batchId) leave this off.
   */
  foreground?: boolean;
};

/**
 * The shared "fix all" button for a Problems section, driven entirely by props.
 * The backfill runs server-side in ONE streamed mutation (see `useBulkStream`);
 * this owns the stream and renders a live `<Progress>` bar beneath the button
 * while it runs, then fires the result-derived toast + invalidations on done.
 * `TResult` is the mutation's final summary (pinned per registry entry).
 */
export function BackfillButton<TResult>({
  run,
  invalidateKeys,
  toastResult,
  idleLabel,
  pendingLabel,
  foreground,
}: BackfillButtonProps<TResult>): ReactNode {
  const api = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const { start, running, progress } = useBulkStream<unknown, TResult>();

  const onClick = () =>
    void start(() => run(client), {
      onDone: (data) => {
        const { tone, message } = toastResult(data);
        toast[tone](message);
        invalidateTRPCQueries(queryClient, [
          ...problemsMutationInvalidateKeys,
          ...(invalidateKeys?.(api) ?? []),
        ]);
      },
    });

  return (
    <Stack gap="xs">
      <ProblemActionButton
        onClick={onClick}
        isPending={running}
        idleLabel={idleLabel}
        pendingLabel={pendingLabel}
      />
      {running && (
        <Progress
          value={progress?.done ?? 0}
          max={progress?.total ?? 1}
          indeterminate={!progress}
        />
      )}
      {running && foreground && (
        <span className="text-2xs text-warning">
          Keep this page open — this runs here, not in the background.
        </span>
      )}
    </Stack>
  );
}
