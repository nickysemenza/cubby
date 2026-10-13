import type { ActivityRun } from "@cubby/schemas/activity";

import { Badge, type BadgeVariant } from "~/ui/primitives/badge";

const states = new Map(
  Object.entries({
    ready: { label: "Completed", variant: "positive" },
    completed: { label: "Completed", variant: "positive" },
    skipped: { label: "Skipped", variant: "secondary" },
    pending: { label: "Queued", variant: "secondary" },
    leased: { label: "Processing", variant: "default" },
    running: { label: "Processing", variant: "default" },
    waiting_for_device: { label: "Waiting for Apple", variant: "warning" },
    paused_auth: { label: "Waiting for sign-in", variant: "warning" },
    paused_offline: { label: "Waiting for connection", variant: "warning" },
    paused_approval: { label: "Waiting for approval", variant: "warning" },
    needs_review: { label: "Needs review", variant: "warning" },
    failed: { label: "Failed", variant: "destructive" },
    dispatch_failed: { label: "Dispatch failed", variant: "destructive" },
  } satisfies Record<string, { label: string; variant: BadgeVariant }>),
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
