import {
  SUGGESTION_ACCEPT_CLEAN_MAX,
  type acceptCleanSuggestionsInput,
} from "@cubby/schemas/suggestion-list";
import { getErrorMessage } from "@cubby/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { z } from "zod";

import { suggestions } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCount } from "~/lib/number-format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/primitives/alert-dialog";
import { Progress } from "~/ui/primitives/progress";

type CleanFilters = z.input<typeof acceptCleanSuggestionsInput>["filters"];

/** What one "Accept N clean" covers: its filters and the count it showed. */
export type CleanTarget = {
  label: string;
  count: number;
  filters: CleanFilters;
};

type Progressing = {
  label: string;
  total: number;
  done: number;
  running: boolean;
  failures: { label: string; error: string }[];
};

/**
 * Accept every clean Suggestion a target covers, behind a confirm. The
 * server re-lists the clean set before each chunk: labels republish a
 * charge's suggestion under a new id while this runs and accepting shrinks
 * the set, so one up-front read goes stale. Attempted ids are never retried;
 * failures stay pending for review and show their raw errors.
 */
export function useAcceptClean() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<CleanTarget | null>(null);
  const [progress, setProgress] = useState<Progressing | null>(null);

  const accept = async (target: CleanTarget) => {
    const failures: Progressing["failures"] = [];
    const attempted = new Set<string>();
    let done = 0;
    let total = target.count;
    setProgress({
      label: target.label,
      total,
      done,
      running: true,
      failures,
    });
    try {
      for (;;) {
        const results = await suggestions.acceptClean.call({
          filters: target.filters,
          limit: SUGGESTION_ACCEPT_CLEAN_MAX,
          skip: [...attempted],
        });
        if (!results.length) break;
        for (const result of results) {
          if (result.assessmentId) attempted.add(result.assessmentId);
          if (!result.ok)
            failures.push({
              label: result.assessmentId ?? "Unknown suggestion",
              error: result.error,
            });
        }
        done += results.length;
        total = Math.max(total, done);
        setProgress({
          label: target.label,
          total,
          done,
          running: true,
          failures: [...failures],
        });
      }
    } catch (error) {
      failures.push({ label: target.label, error: getErrorMessage(error) });
    }
    setProgress({
      label: target.label,
      total: Math.max(total, done),
      done,
      running: false,
      failures,
    });
    await invalidateOperationTags(
      queryClient,
      suggestions.acceptClean.invalidates({ filters: target.filters }),
    );
  };

  const dialogs = (
    <>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Accept {formatCount(confirming?.count ?? 0)} clean suggestions?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.label}. Each records or settles a transaction from
              its statement row and books no spending. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirming;
                setConfirming(null);
                if (target) void accept(target);
              }}
            >
              Accept {formatCount(confirming?.count ?? 0)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {progress ? <AcceptProgress state={progress} /> : null}
    </>
  );
  return {
    confirm: setConfirming,
    running: progress?.running === true,
    dialogs,
  };
}

function AcceptProgress({ state }: { state: Progressing }) {
  return (
    <div className="space-y-1" aria-live="polite">
      <p className="text-xs text-muted-foreground tabular-nums">
        {state.label}: Accepted{" "}
        {formatCount(state.done - state.failures.length)} of{" "}
        {formatCount(state.total)}
        {state.failures.length
          ? ` · ${formatCount(state.failures.length)} failed`
          : ""}
        {state.running ? "…" : ""}
      </p>
      <Progress value={state.done} max={Math.max(state.total, 1)} />
      {state.failures.length ? (
        <ul className="space-y-0.5 text-xs" aria-label="Failed suggestions">
          {state.failures.map((failure, index) => (
            <li
              // Failures have no stable id beyond their order of arrival.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className="text-destructive"
            >
              <span className="font-medium">{failure.label}</span>:{" "}
              <span className="whitespace-pre-wrap">{failure.error}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
