import type { PhotoRunReview } from "@cubby/schemas/photo-import-run";
import { useMutation, useQueryClient } from "@tanstack/react-query";

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
}: {
  run: ImportRunDetail;
  review?: PhotoRunReview;
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
      <CardContent className="grid gap-2">
        <p className="text-sm font-medium">{stage}</p>
        <Progress
          value={settled}
          max={Math.max(photos.length, 1)}
          aria-label="Photos reviewed"
        />
        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          {settled} of {photos.length} photos settled
        </p>
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
  return (
    <Stack gap="lg">
      <PhotoRunProgress run={run} review={review.data} />
      {run.status === "running" && !run.dispatch?.eventId && !hasProposals ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">Group your photos</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              After upload, ask the agent to propose items. Review and approve
              each group before any Product or Inventory is created.
            </p>
            <div>
              <Button
                type="button"
                disabled={!pending || start.isPending}
                onClick={() => start.mutate()}
              >
                {start.isPending
                  ? "Starting agent…"
                  : "Ask agent to group photos"}
              </Button>
            </div>
            {!pending ? (
              <StatusText tone="muted">
                Upload and finalize photos in the Cubby app first.
              </StatusText>
            ) : null}
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
          </CardContent>
        </Card>
      ) : null}
      {run.status === "running" && run.dispatch?.eventId ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">
              {run.latestProgress?.awaitingApproval
                ? "Ready for your review"
                : "Agent is grouping photos"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StatusText tone="muted">
              {run.latestProgress?.awaitingApproval
                ? "Review each proposed item below. Products and Inventory are created only when you approve a group."
                : (run.latestProgress?.detail ??
                  "The agent is reading the uploaded photos and preparing item groups.")}
            </StatusText>
          </CardContent>
        </Card>
      ) : null}
      <PhotoGroupReview runId={run.publicId} runStatus={run.status} />
    </Stack>
  );
}
