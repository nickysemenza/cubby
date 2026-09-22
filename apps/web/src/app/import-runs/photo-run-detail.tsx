import type { ImportRunTargetState } from "@cubby/schemas/purchase-import";

import { Row, Stack } from "~/components/layout";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { StatusText } from "~/components/ui/status-text";
import {
  IMPORT_RUN_TARGET_STATE_LABEL,
  IMPORT_RUN_TARGET_STATE_ORDER,
  IMPORT_RUN_TARGET_STATE_VARIANT,
  isImportRunTargetState,
} from "~/lib/import-run-target-state";
import type { ImportRunDetail } from "~/lib/purchase-import-run-detail";

import { PhotoGroupReview } from "./photo-group-review";

const runStatusVariant = (status: string): BadgeVariant => {
  if (status === "completed") return "positive";
  if (status === "failed" || status === "dispatch_failed") return "destructive";
  if (status.startsWith("paused") || status === "needs_review")
    return "warning";
  return "secondary";
};

const formatMoment = (value: string | null): string =>
  value ? new Date(value).toLocaleString() : "Still active";

function StateBadge({ state }: { state: string }) {
  const known = isImportRunTargetState(state) ? state : null;
  return (
    <Badge variant={known ? IMPORT_RUN_TARGET_STATE_VARIANT[known] : "outline"}>
      {known ? IMPORT_RUN_TARGET_STATE_LABEL[known] : state}
    </Badge>
  );
}

function PhotoRunHeader({ run }: { run: ImportRunDetail }) {
  const owner = run.actor?.ledgerParty?.name ?? run.actor?.name ?? null;
  return (
    <Card>
      <CardHeader>
        <Row align="center" justify="between" wrap gap="sm">
          <Row align="center" gap="sm">
            <CardTitle as="h2" className="font-mono text-base">
              {run.publicId}
            </CardTitle>
            <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
          </Row>
          <span className="text-xs text-muted-foreground">
            {owner ? `Uploaded by ${owner}` : "Uploaded by a household member"}
          </span>
        </Row>
      </CardHeader>
      <CardContent>
        <Stack gap="sm">
          <Row wrap gap="lg" className="text-xs text-muted-foreground">
            <span>Started {formatMoment(run.startedAt)}</span>
            <span>Finished {formatMoment(run.endedAt)}</span>
          </Row>
          {run.notes ? (
            <p className="text-sm">{run.notes}</p>
          ) : (
            <StatusText tone="muted">
              No notes were attached to this batch.
            </StatusText>
          )}
          {run.failureCode ? (
            <StatusText tone="destructive">{run.failureCode}</StatusText>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
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

/** The photo-inventory counterpart of the purchase-agent run detail: the
 * agent's proposed item groups to review and every run photo, rather than an
 * agent transcript. */
export function PhotoImportRunView({ run }: { run: ImportRunDetail }) {
  return (
    <Stack gap="lg" className="pb-8">
      <a
        className="text-sm text-primary hover:underline"
        href="/activity?tab=runs&kind=photo_inventory"
      >
        Back to Activity
      </a>
      <PhotoRunHeader run={run} />
      <PhotoRunProgress run={run} />
      <PhotoGroupReview runId={run.publicId} runStatus={run.status} />
    </Stack>
  );
}
