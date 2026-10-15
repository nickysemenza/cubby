import type { PhotoRunReview } from "@cubby/schemas/photo-import-run";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";

import type { RunDetail } from "~/contracts/run.contract";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { DetailAction } from "~/entity/entity-detail/detail-action-bar";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { ShortcodeProse } from "~/entity/prose/shortcode-prose";
import {
  run as runOperations,
  photoImport,
  imageProcessing,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { AiCost } from "~/ui/common/ai-cost";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/primitives/card";
import { Progress } from "~/ui/primitives/progress";
import { StatusText } from "~/ui/primitives/status-text";

import { runHasAgent } from "./agent-observation";
import { PhotoGroupReview, usePhotoRunReview } from "./photo-group-review";

function PhotoRunCost({ run }: { run: RunDetail }) {
  const usage = useQuery({
    ...runOperations.aiUsage.queryOptions({ runId: run.publicId, limit: 1 }),
    refetchInterval: run.status === "running" ? 5000 : false,
  });
  if (usage.isError)
    return <StatusText tone="destructive">{usage.error.message}</StatusText>;
  if (!usage.data) return null;
  return (
    <div aria-live="polite">
      <p className="text-xs text-muted-foreground">
        Run cost · includes all nested work
      </p>
      <AiCost cost={usage.data} />
    </div>
  );
}

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
  const describing =
    run.status === "running" &&
    photos.length > 0 &&
    described < photos.length &&
    !run.dispatch?.eventId &&
    readyGroups === 0;
  const grouping =
    Boolean(run.dispatch?.eventId) &&
    readyGroups === 0 &&
    run.status === "running";
  const phase = review?.lifecycle?.phase;
  const uploading = phase === "waiting_for_upload";
  const handoffReady = phase === "ready_for_handoff";
  const total = uploading
    ? (review?.lifecycle?.plannedImageCount ?? photos.length)
    : photos.length;
  const lifecycleTitle = phase
    ? {
        waiting_for_upload: "Waiting for the remaining uploads",
        describing: "Preparing photo descriptions",
        needs_attention: "Photo import needs attention",
        grouping: "Cubby is preparing item groups",
        ready_for_handoff: "Ready for Claude/Codex",
        ready_for_review: `${readyGroups} item groups ready for your review`,
        completed: "Review complete",
      }[phase]
    : undefined;
  const stage =
    lifecycleTitle ??
    (photos.length === 0
      ? "Waiting for photos to upload"
      : run.status === "completed"
        ? "Review complete"
        : readyGroups > 0
          ? `${readyGroups} item ${readyGroups === 1 ? "group" : "groups"} ready for your review`
          : run.status === "needs_review"
            ? "Agent stopped; group photos for review"
            : run.dispatch?.eventId
              ? "Agent is preparing item groups"
              : describing || handoffReady
                ? "Preparing photo descriptions"
                : "Photos uploaded; ready to group");
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Progress</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm font-medium">{stage}</p>
        <PhotoRunCost run={run} />
        <Progress
          value={
            uploading
              ? review?.lifecycle?.finalizedImageCount
              : describing || handoffReady
                ? described
                : settled
          }
          max={Math.max(total, 1)}
          indeterminate={grouping}
          aria-label={
            uploading
              ? "Uploads received"
              : describing || handoffReady
                ? "Cloud descriptions"
                : grouping
                  ? "Grouping photos"
                  : "Photos reviewed"
          }
        />
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          {uploading
            ? `${review?.lifecycle?.finalizedImageCount ?? 0} of ${total} photos received`
            : grouping
              ? "Grouping the uploaded photos…"
              : handoffReady
                ? `${photos.length} photos ready for your Claude/Codex session`
                : describing
                  ? `${described} of ${photos.length} descriptions ready`
                  : `${settled} of ${photos.length} photos settled`}
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

function groupingHint(
  pending: number,
  analyzing: boolean,
  paused: boolean,
  external: boolean,
) {
  if (!pending) return "Upload and finalize photos in the Cubby app first.";
  if (analyzing && paused)
    return "Image processing is paused, so photo descriptions are queued. Resume queued work under Problems → Image processing to start grouping.";
  if (analyzing)
    return external
      ? "Photos are processing. Your Claude/Codex handoff will be ready once descriptions finish."
      : "Photos are processing. Grouping starts once descriptions are ready.";
  return "The agent proposes items; you approve each one before anything is created.";
}

/** The photo-inventory counterpart of the purchase-agent run workflow: the
 * agent's proposed item groups to review and every run photo, rather than an
 * agent transcript. */
export function PhotoImportRunView({ run }: { run: RunDetail }) {
  const review = usePhotoRunReview(run.publicId, run.status, runHasAgent(run));
  const pending = run.targets.filter(
    (target) => target.targetType === "image" && target.state === "pending",
  ).length;
  const hasProposals = Boolean(
    review.data?.review.proposals.some(
      (proposal) => proposal.state === "proposed",
    ),
  );
  const analyzing = descriptionsInFlight(review.data);
  const exclude = useActionMutation({
    mutationFn: photoImport.excludeFailed.mutationOptions,
    success: "Failed photos skipped; originals retained",
  });
  const finishUploads = useActionMutation({
    mutationFn: photoImport.sealBatch.mutationOptions,
    success: "Upload batches closed; uploaded photos retained",
  });
  const retry = useMutation({
    mutationFn: async (ids: string[]) => {
      const outcomes = await Promise.allSettled(
        ids.map((id) => imageProcessing.retry.call({ id })),
      );
      const errors = outcomes.flatMap((outcome, index) =>
        outcome.status === "rejected"
          ? [
              `${ids[index]}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
            ]
          : [],
      );
      if (errors.length) throw new Error(errors.join("\n"));
    },
    onSettled: () => {
      void review.refetch();
    },
  });
  const failed = review.data?.lifecycle?.failedImageIds ?? [];
  return (
    <Stack gap="lg">
      <PhotoRunProgress run={run} review={review.data}>
        {review.data?.lifecycle.phase === "waiting_for_upload" ? (
          <Stack gap="sm">
            <StatusText tone="muted">
              If an interrupted upload cannot resume, finish with the photos
              already received. Remaining photos will not be added to this run.
            </StatusText>
            <Button
              variant="outline"
              disabled={finishUploads.isPending}
              onClick={() => finishUploads.mutate({ runId: run.publicId })}
            >
              Finish with uploaded photos
            </Button>
          </Stack>
        ) : null}
        {review.data?.lifecycle.dispatchError ? (
          <StatusText tone="destructive">
            {review.data.lifecycle.dispatchError}{" "}
            {review.data.lifecycle.dispatchError.includes(
              "Connect the Cubby agent",
            ) ? (
              <a href="/api/import/agent/oauth/start" className="underline">
                Connect the Cubby agent
              </a>
            ) : null}
          </StatusText>
        ) : null}
        {failed.length > 0 ? (
          <Stack gap="sm">
            <StatusText tone="destructive">
              {failed.length} photos need a description retry. Successful photos
              are retained.
            </StatusText>
            <ul className="space-y-1 text-xs">
              {failed.map((id) => (
                <li key={id} className="flex flex-wrap items-baseline gap-2">
                  <EntityRefLink
                    variant="chip"
                    entity="image"
                    id={id}
                    name={id}
                    displayImage={null}
                  />
                  <span>
                    {review.data?.images.find((image) => image.id === id)
                      ?.describeReason ?? "Cloud description failed"}
                  </span>
                </li>
              ))}
            </ul>
            <Row gap="sm" wrap>
              <Button
                variant="outline"
                disabled={retry.isPending || exclude.isPending}
                onClick={() => retry.mutate(failed)}
              >
                Retry failed descriptions
              </Button>
              <Button
                variant="outline"
                disabled={retry.isPending || exclude.isPending}
                onClick={() =>
                  exclude.mutate({ runId: run.publicId, imageIds: failed })
                }
              >
                Continue without failed photos
              </Button>
            </Row>
            {retry.isError ? (
              <StatusText tone="destructive">{retry.error.message}</StatusText>
            ) : null}
          </Stack>
        ) : null}
        {run.status === "running" &&
        (review.data?.lifecycle.processor === "external" ||
          Boolean(review.data?.lifecycle.dispatchError) ||
          (!run.dispatch?.eventId && !hasProposals)) ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <DetailAction>
              <PhotoRunGroupingAction run={run} />
            </DetailAction>
            <p className="text-sm text-muted-foreground">
              {groupingHint(
                pending,
                analyzing,
                review.data?.imageProcessingPaused ?? false,
                review.data?.lifecycle.processor === "external",
              )}
            </p>
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
      <PhotoGroupReview
        runId={run.publicId}
        runStatus={run.status}
        hasAgent={runHasAgent(run)}
      />
    </Stack>
  );
}

export function PhotoRunGroupingAction({ run }: { run: RunDetail }) {
  const review = usePhotoRunReview(run.publicId, run.status, runHasAgent(run));
  const autoStartAttempted = useRef(false);
  const start = useMutation(photoImport.startGrouping.mutationOptions());
  const copy = useMutation({
    mutationFn: () =>
      navigator.clipboard.writeText(
        `Use the photo-inventory-import skill to group pending photos in ${run.publicId}. Read photo context and existing Product candidates, propose item groups for my review, and stop before approval.`,
      ),
  });
  const pending = run.targets.filter(
    (target) => target.targetType === "image" && target.state === "pending",
  ).length;
  const hasProposals = Boolean(
    review.data?.review.proposals.some(
      (proposal) => proposal.state === "proposed",
    ),
  );
  const analyzing = descriptionsInFlight(review.data);
  useEffect(() => {
    if (
      review.data?.lifecycle?.processor != null ||
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
    review.data?.lifecycle.processor,
    analyzing,
    hasProposals,
    start,
  ]);
  if (run.status !== "running") return null;
  if (review.data?.lifecycle?.processor === "external")
    return (
      <Stack gap="xs">
        <Button
          variant="outline"
          disabled={
            !pending ||
            review.data.lifecycle.openBatchCount > 0 ||
            analyzing ||
            review.data.lifecycle.failedImageIds.length > 0 ||
            copy.isPending
          }
          onClick={() => copy.mutate()}
        >
          {copy.isSuccess
            ? "Import prompt copied"
            : "Copy prompt for Claude/Codex"}
        </Button>
        {copy.isError ? (
          <StatusText tone="destructive">{copy.error.message}</StatusText>
        ) : null}
      </Stack>
    );
  if (
    (run.dispatch?.eventId && !review.data?.lifecycle.dispatchError) ||
    hasProposals
  )
    return null;
  if (
    review.data?.lifecycle?.processor === "cubby" &&
    !review.data.lifecycle.dispatchError
  )
    return (
      <StatusText tone="muted">
        Cubby starts grouping automatically after uploads and required
        descriptions finish.
      </StatusText>
    );
  return (
    <>
      <Button
        type="button"
        disabled={!pending || analyzing || start.isPending}
        onClick={() => start.mutate({ runId: run.publicId })}
        className="min-h-11"
      >
        {start.isPending ? "Starting agent…" : "Start grouping"}
      </Button>
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
    </>
  );
}
