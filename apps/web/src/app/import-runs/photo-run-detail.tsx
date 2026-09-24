import type { ImportRunTargetState } from "@cubby/schemas/purchase-import";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { StatusText } from "~/components/ui/status-text";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { throwHttpError } from "~/lib/http-error";
import {
  IMPORT_RUN_TARGET_STATE_LABEL,
  IMPORT_RUN_TARGET_STATE_ORDER,
  IMPORT_RUN_TARGET_STATE_VARIANT,
  isImportRunTargetState,
} from "~/lib/import-run-target-state";
import type { ImportRunDetail } from "~/lib/purchase-import-run-detail";

import { PhotoGroupReview, usePhotoRunReview } from "./photo-group-review";

function StateBadge({ state }: { state: string }) {
  const known = isImportRunTargetState(state) ? state : null;
  return (
    <Badge variant={known ? IMPORT_RUN_TARGET_STATE_VARIANT[known] : "outline"}>
      {known ? IMPORT_RUN_TARGET_STATE_LABEL[known] : state}
    </Badge>
  );
}

function PhotoRunProgress({ run }: { run: ImportRunDetail }) {
  const tallies = new Map<ImportRunTargetState, number>();
  for (const target of run.targets) {
    if (target.targetType !== "image") continue;
    if (!isImportRunTargetState(target.state)) continue;
    tallies.set(target.state, (tallies.get(target.state) ?? 0) + 1);
  }
  const present = IMPORT_RUN_TARGET_STATE_ORDER.filter((state) =>
    tallies.get(state),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Progress</CardTitle>
      </CardHeader>
      <CardContent>
        {present.length ? (
          <Row wrap gap="md">
            {present.map((state) => (
              <Stack key={state} gap="tight" className="min-w-20">
                <span className="font-mono text-lg tabular-nums">
                  {tallies.get(state)}
                </span>
                <StateBadge state={state} />
              </Stack>
            ))}
          </Row>
        ) : (
          <StatusText tone="muted">
            No photos have been targeted yet.
          </StatusText>
        )}
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
      <PhotoRunProgress run={run} />
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
