import type { PhotoRunReview } from "@cubby/schemas/photo-import-run";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";

import { Stack } from "~/components/layout";
import { ShortcodeProse } from "~/components/shortcode-prose";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Progress } from "~/components/ui/progress";
import { StatusText } from "~/components/ui/status-text";
import type { RunDetail } from "~/contracts/run.contract";
import { photoImport } from "~/entities/run.functions";

import { PhotoGroupReview, usePhotoRunReview } from "./photo-group-review";

function PhotoRunProgress({
  run,
  review,
  children,
}: {
  run: RunDetail;
  review?: PhotoRunReview;
  children?: ReactNode;
}) {
  const photos = run.targets.filter((target) => target.targetType === "image");
  const settled = photos.filter(
    (target) => target.state === "completed" || target.state === "skipped",
  ).length;
  const readyGroups =
    review?.review.proposals.filter((proposal) => proposal.state === "proposed")
      .length ?? 0;
  const imageWork = review?.images ?? [];
  const deviceDone = imageWork.filter(
    (photo) => photo.localAnalysisReady,
  ).length;
  const deviceFailed = imageWork.filter(
    (photo) => photo.deviceWorkState === "failed",
  ).length;
  const described = imageWork.filter(
    (photo) => photo.describe === "ready" || photo.describe === "skipped",
  ).length;
  const cutoutsSettled = imageWork.filter(
    (photo) => photo.cutout === "ready" || photo.cutout === "skipped",
  ).length;
  const stage =
    photos.length === 0
      ? "Waiting for photos to upload"
      : run.status === "completed"
        ? "Review complete"
        : readyGroups > 0
          ? `${readyGroups} item ${readyGroups === 1 ? "group" : "groups"} ready for your review`
          : run.status === "needs_review"
            ? "Agent stopped; group photos for review"
            : run.dispatch?.eventId
              ? "Agent is preparing item groups"
              : "Photos uploaded; ready to group";
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Progress</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm font-medium">{stage}</p>
        <Progress
          value={settled}
          max={Math.max(photos.length, 1)}
          aria-label="Photos reviewed"
        />
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          {settled} of {photos.length} photos settled
        </p>
        {imageWork.length ? (
          <div
            className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-3"
            aria-live="polite"
          >
            {[
              { label: "Device analysis", done: deviceDone, optional: true },
              { label: "Cloud description", done: described, optional: false },
              { label: "Subject lift", done: cutoutsSettled, optional: true },
            ].map((work) => (
              <div key={work.label} className="flex items-baseline gap-2">
                <p className="text-2xs text-muted-foreground">
                  {work.label}
                  {work.optional ? " · optional" : ""}
                </p>
                <p className="font-mono text-xs font-semibold tabular-nums">
                  {work.done} / {imageWork.length}
                </p>
              </div>
            ))}
          </div>
        ) : null}
        {deviceFailed > 0 ? (
          <StatusText tone="destructive">
            {deviceFailed} {deviceFailed === 1 ? "photo" : "photos"} failed
            on-device processing. Retry from the Cubby app.
          </StatusText>
        ) : null}
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * Mirrors the server gate in `startPhotoGroupingForActor`: a coordinator
 * started before descriptions settle has nothing to group on.
 */
function descriptionsInFlight(review: PhotoRunReview | undefined) {
  return Boolean(
    review?.images.some(
      (image) =>
        image.targetState === "pending" &&
        (image.describe === "pending" ||
          image.describe === "leased" ||
          image.describe === "waiting_for_device"),
    ),
  );
}

function groupingHint(pending: number, analyzing: boolean) {
  if (!pending) return "Upload and finalize photos in the Cubby app first.";
  if (analyzing)
    return "Photos are processing. Grouping starts once descriptions are ready.";
  return "The agent proposes items; you approve each one before anything is created.";
}

/** The photo-inventory counterpart of the purchase-agent run workflow: the
 * agent's proposed item groups to review and every run photo, rather than an
 * agent transcript. */
export function PhotoImportRunView({ run }: { run: RunDetail }) {
  const review = usePhotoRunReview(run.publicId, run.status);
  const autoStartAttempted = useRef(false);
  const start = useMutation(photoImport.startGrouping.mutationOptions());
  const pending = run.targets.filter(
    (target) => target.targetType === "image" && target.state === "pending",
  ).length;
  const hasProposals = Boolean(review.data?.review.proposals.length);
  const analyzing = descriptionsInFlight(review.data);
  useEffect(() => {
    if (
      autoStartAttempted.current ||
      new URLSearchParams(window.location.search).get("startGrouping") !==
        "1" ||
      run.status !== "running" ||
      run.dispatch?.eventId ||
      !pending ||
      review.isPending ||
      analyzing ||
      hasProposals
    )
      return;
    autoStartAttempted.current = true;
    start.mutate({ runId: run.publicId });
  }, [
    run.publicId,
    run.status,
    run.dispatch?.eventId,
    pending,
    review.isPending,
    analyzing,
    hasProposals,
    start,
  ]);
  return (
    <Stack gap="lg">
      <PhotoRunProgress run={run} review={review.data}>
        {run.status === "running" && !run.dispatch?.eventId && !hasProposals ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <Button
              type="button"
              disabled={!pending || analyzing || start.isPending}
              onClick={() => start.mutate({ runId: run.publicId })}
              className="min-h-11"
            >
              {start.isPending ? "Starting agent…" : "Start grouping"}
            </Button>
            <p className="text-sm text-muted-foreground">
              {groupingHint(pending, analyzing)}
            </p>
            {start.isError ? (
              <StatusText tone="destructive">
                {start.error.message}{" "}
                {start.error.message.includes("Connect the Cubby agent") ? (
                  <a href="/api/import/agent/oauth/start" className="underline">
                    Connect agent
                  </a>
                ) : null}
              </StatusText>
            ) : null}
          </div>
        ) : null}
        {run.status === "running" && run.dispatch?.eventId ? (
          <StatusText tone="muted">
            {run.latestProgress?.awaitingApproval ? (
              "Review each proposed item below. Products and Inventory are created when you approve a group."
            ) : (
              <ShortcodeProse>
                {run.latestProgress?.detail ??
                  "The agent is reading the uploaded photos and preparing item groups."}
              </ShortcodeProse>
            )}
          </StatusText>
        ) : null}
      </PhotoRunProgress>
      <PhotoGroupReview runId={run.publicId} runStatus={run.status} />
    </Stack>
  );
}
