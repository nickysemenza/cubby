import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { Progress } from "~/components/ui/progress";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import { useTRPC, useTRPCClient } from "~/trpc/react";
import { ProblemActionButton } from "./problem-action-button";

type TRPCApi = ReturnType<typeof useTRPC>;
type TRPCClient = ReturnType<typeof useTRPCClient>;

/** Result-driven toast: which sonner variant to fire and with what message. */
export type BackfillToast = { tone: "success" | "info"; message: string };

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
        queryClient.invalidateQueries({
          queryKey: [api.problems.getAllProblems.queryKey()],
        });
        for (const key of invalidateKeys?.(api) ?? []) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      },
    });

  return (
    <div className="flex flex-col gap-1">
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
    </div>
  );
}
