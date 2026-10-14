import type { ActivityRun } from "@cubby/schemas/activity";
import type { ReportRowState } from "@cubby/schemas/entity-report";

import { RecordDot } from "~/ui/common/record-list";
import { Badge, type BadgeVariant } from "~/ui/primitives/badge";

const states = new Map(
  Object.entries({
    ready: { label: "Completed", variant: "positive", kind: "done" },
    completed: { label: "Completed", variant: "positive", kind: "done" },
    skipped: { label: "Skipped", variant: "secondary", kind: "skipped" },
    pending: { label: "Queued", variant: "secondary", kind: "not_reached" },
    leased: { label: "Processing", variant: "default", kind: "running" },
    running: { label: "Processing", variant: "default", kind: "running" },
    waiting_for_device: {
      label: "Waiting for Apple",
      variant: "warning",
      kind: "warning",
    },
    paused_auth: {
      label: "Waiting for sign-in",
      variant: "warning",
      kind: "warning",
    },
    paused_offline: {
      label: "Waiting for connection",
      variant: "warning",
      kind: "warning",
    },
    paused_approval: {
      label: "Waiting for approval",
      variant: "warning",
      kind: "warning",
    },
    needs_review: {
      label: "Needs review",
      variant: "warning",
      kind: "warning",
    },
    failed: { label: "Failed", variant: "destructive", kind: "failed" },
    dispatch_failed: {
      label: "Dispatch failed",
      variant: "destructive",
      kind: "failed",
    },
  } satisfies Record<
    string,
    { label: string; variant: BadgeVariant; kind: ReportRowState }
  >),
);

export const workStateLabel = (state: string) =>
  states.get(state)?.label ?? state.replaceAll("_", " ");

export function WorkState({ state }: { state: string }) {
  return (
    <Badge variant={states.get(state)?.variant ?? "secondary"}>
      {workStateLabel(state)}
    </Badge>
  );
}

/** A work state as a record row's mark; an unknown state keeps its label without a mark. */
export function WorkStateDot({ state }: { state: string }) {
  return (
    <RecordDot state={states.get(state)?.kind} label={workStateLabel(state)} />
  );
}

/** Stored diagnostics remain intact; the presentation distinguishes Apple outcomes from old policy skips. */
export function workIssueText(
  run: Pick<ActivityRun, "recordType" | "state" | "error" | "executors">,
) {
  if (run.recordType !== "image_job" || run.state !== "skipped")
    return run.error;
  switch (run.error) {
    case "no_subject":
      return "Apple found no foreground subject.";
    case "unsupported_format":
      return "Apple cannot process this image format.";
    case "not_suitable":
      return run.executors.some((executor) => executor.kind === "device")
        ? "The image already has a transparent background."
        : "The previous cloud eligibility policy skipped subject lift. Queue missing processing to retry.";
    case "Image is attached only as label evidence":
      return "The previous label-only policy skipped subject lift. Queue missing processing to retry.";
    default:
      return run.error;
  }
}
