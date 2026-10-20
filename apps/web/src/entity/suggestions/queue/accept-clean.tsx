import {
  SUGGESTION_ACCEPT_CLEAN_MAX,
  SUGGESTION_ACCEPT_SKIP_MAX,
  type acceptCleanSuggestionsInput,
  type SuggestionRecordRef,
} from "@cubby/schemas/suggestion-list";
import { getErrorMessage } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
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

import { RecordLink } from "./suggestion-values";

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
  failures: Failure[];
};

/** A failed accept names its record when the row is loaded, else the scope. */
type Failure = {
  record: SuggestionRecordRef | null;
  label: string;
  error: string;
};

/**
 * Accept every clean Suggestion a target covers, behind a confirm. The
 * server re-lists the clean set before each chunk: labels republish a
 * charge's suggestion under a new id while this runs and accepting shrinks
 * the set, so one up-front read goes stale. Accepted ids leave the clean
 * set on their own; only failures are skipped (bounded by the server's skip
 * limit), stay pending for review and show their raw errors.
 */
export function useAcceptClean(
  /** The loaded row's record for an Assessment id, to name a failure. */
  recordOf: (assessmentId: string) => SuggestionRecordRef | undefined,
) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<CleanTarget | null>(null);
  const [progress, setProgress] = useState<Progressing | null>(null);

  const accept = async (target: CleanTarget) => {
    const failures: Progressing["failures"] = [];
    const failed = new Set<string>();
    const accepted = new Set<string>();
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
        if (
          failed.size >
          SUGGESTION_ACCEPT_SKIP_MAX - SUGGESTION_ACCEPT_CLEAN_MAX
        ) {
          failures.push({
            record: null,
            label: target.label,
            error: `Stopped after ${formatCount(failed.size)} failures; review them, then accept the rest.`,
          });
          break;
        }
        const results = await suggestions.acceptClean.call({
          filters: target.filters,
          limit: SUGGESTION_ACCEPT_CLEAN_MAX,
          skip: [...failed],
        });
        if (!results.length) break;
        // A chunk with no unseen id moved nothing; report it once, then stop.
        const progressed = results.some(
          (result) =>
            result.assessmentId &&
            !accepted.has(result.assessmentId) &&
            !failed.has(result.assessmentId),
        );
        for (const result of results) {
          if (result.assessmentId)
            (result.ok ? accepted : failed).add(result.assessmentId);
          if (!result.ok)
            failures.push({
              record:
                (result.assessmentId && recordOf(result.assessmentId)) || null,
              label: result.assessmentId
                ? "A suggestion outside the loaded rows"
                : "A suggestion the server could not identify",
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
        if (!progressed) break;
      }
    } catch (error) {
      failures.push({
        record: null,
        label: target.label,
        error: getErrorMessage(error),
      });
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
              Accept{" "}
              {countLabel(confirming?.count ?? 0, "clean suggestion", {
                formatted: true,
              })}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.label}. Posted spending is booked or linked to
              existing Purchases. Pending holds and other transaction kinds
              remain settlement-only. There is no undo.
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
              {failure.record ? (
                <RecordLink record={failure.record} />
              ) : (
                <span className="font-medium">{failure.label}</span>
              )}
              : <span className="whitespace-pre-wrap">{failure.error}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
