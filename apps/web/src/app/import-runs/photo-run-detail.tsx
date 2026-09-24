import type { PhotoRunReview } from "@cubby/schemas/photo-import-run";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";

import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Progress } from "~/components/ui/progress";
import { StatusText } from "~/components/ui/status-text";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { throwHttpError } from "~/lib/http-error";
import type { ImportRunDetail } from "~/lib/purchase-import-run-detail";

import { PhotoGroupReview, usePhotoRunReview } from "./photo-group-review";

function PhotoRunProgress({
  run,
  review,
  children,
}: {
  run: ImportRunDetail;
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
  const stage =
    photos.length === 0
      ? "Waiting for photos to upload"
      : run.status === "completed"
        ? "Review complete"
        : readyGroups > 0
          ? `${readyGroups} item ${readyGroups === 1 ? "group" : "groups"} ready for your review`
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
        {children}
      </CardContent>
    </Card>
  );
}

/** The photo-inventory counterpart of the purchase-agent run workflow: the
 * agent's proposed item groups to review and every run photo, rather than an
 * agent transcript. */
export function PhotoImportRunView({ run }: { run: ImportRunDetail }) {
  const queryClient = useQueryClient();
  const review = usePhotoRunReview(run.publicId, run.status);
  const autoStartAttempted = useRef(false);
  const start = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/import/runs/${encodeURIComponent(run.publicId)}/photo-agent`,
        { method: "POST" },
      );
      if (!response.ok)
        await throwHttpError(response, "Photo agent could not start", {
          method: "POST",
        });
    },
    onSuccess: () => void invalidateOperationTags(queryClient, ripple.runOnly),
  });
  const pending = run.targets.filter(
    (target) => target.targetType === "image" && target.state === "pending",
  ).length;
  const hasProposals = Boolean(review.data?.review.proposals.length);
  useEffect(() => {
    if (
      autoStartAttempted.current ||
      new URLSearchParams(window.location.search).get("startGrouping") !==
        "1" ||
      run.status !== "running" ||
      run.dispatch?.eventId ||
      !pending ||
      review.isPending ||
      hasProposals
    )
      return;
    autoStartAttempted.current = true;
    start.mutate();
  }, [
    run.status,
    run.dispatch?.eventId,
    pending,
    review.isPending,
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
              disabled={!pending || start.isPending}
              onClick={() => start.mutate()}
              className="min-h-11"
            >
              {start.isPending ? "Starting agent…" : "Start grouping"}
            </Button>
            <p className="text-sm text-muted-foreground">
              {pending
                ? "The agent proposes items; you approve each one before anything is created."
                : "Upload and finalize photos in the Cubby app first."}
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
            {run.latestProgress?.awaitingApproval
              ? "Review each proposed item below. Products and Inventory are created when you approve a group."
              : (run.latestProgress?.detail ??
                "The agent is reading the uploaded photos and preparing item groups.")}
          </StatusText>
        ) : null}
      </PhotoRunProgress>
      <PhotoGroupReview runId={run.publicId} runStatus={run.status} />
    </Stack>
  );
}
