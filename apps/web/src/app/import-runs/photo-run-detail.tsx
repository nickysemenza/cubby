import type { ImageWithEntity } from "@cubby/schemas/image";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import type { ImportRunTargetState } from "@cubby/schemas/purchase-import";
import { useQuery } from "@tanstack/react-query";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Grid, Row, Stack } from "~/components/layout";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Image } from "~/components/ui/image";
import { StatusText } from "~/components/ui/status-text";
import { image } from "~/entities/image.functions";
import {
  IMPORT_RUN_TARGET_STATE_LABEL,
  IMPORT_RUN_TARGET_STATE_ORDER,
  IMPORT_RUN_TARGET_STATE_VARIANT,
  isImportRunTargetState,
} from "~/lib/import-run-target-state";
import type { ImportRunDetail } from "~/lib/purchase-import-run-detail";

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

function PhotoTargetCard({ runImage }: { runImage: ImageWithEntity }) {
  const state = runImage.importTarget?.state;
  const recognizedFirstLine = runImage.analysisSummary?.recognizedText
    ?.split("\n")[0]
    ?.trim();
  return (
    <Stack gap="tight" className="min-w-0">
      <a
        href={`/images/${encodeURIComponent(runImage.id)}`}
        className="block overflow-hidden rounded-md border border-border"
      >
        <Image
          src={preferredImageUrl(runImage)}
          alt={runImage.filename}
          displayWidth={200}
          className="aspect-square w-full object-cover"
        />
      </a>
      <Row align="center" justify="between" gap="sm">
        <EntityInlineLink
          entity="image"
          data={{ id: runImage.id, filename: runImage.filename }}
          displayImage={null}
          showIdentityMark
          truncate
          className="min-w-0 text-xs"
        />
        {runImage.importTarget?.position != null ? (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">
            #{runImage.importTarget.position}
          </span>
        ) : null}
      </Row>
      {state ? <StateBadge state={state} /> : null}
      {recognizedFirstLine ? (
        <p
          className="truncate text-2xs text-muted-foreground"
          title={recognizedFirstLine}
        >
          {recognizedFirstLine}
        </p>
      ) : null}
      {runImage.analysisSummary?.classifications.length ? (
        <Row wrap gap="tight">
          {runImage.analysisSummary.classifications.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </Row>
      ) : null}
    </Stack>
  );
}

function usePhotoRunImages(runId: string) {
  return useQuery(
    image.list.queryOptions({
      filters: { importRunId: [runId] },
      pagination: { pageIndex: 0, pageSize: 200 },
    }),
  );
}

function PhotoRunTargets({ run }: { run: ImportRunDetail }) {
  const images = usePhotoRunImages(run.publicId);
  if (images.isLoading)
    return (
      <Card>
        <CardContent>
          <StatusText>Loading photos…</StatusText>
        </CardContent>
      </Card>
    );
  if (images.isError)
    return (
      <Card>
        <CardContent>
          <StatusText tone="destructive">{images.error.message}</StatusText>
        </CardContent>
      </Card>
    );
  const items = images.data?.items ?? [];
  if (!items.length)
    return (
      <Card>
        <CardContent>
          <StatusText tone="muted">
            No photos have been uploaded for this batch.
          </StatusText>
        </CardContent>
      </Card>
    );

  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const key = item.importTarget?.state ?? "pending";
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const orderedStates = IMPORT_RUN_TARGET_STATE_ORDER.filter((state) =>
    groups.has(state),
  );

  return (
    <Stack gap="lg">
      {orderedStates.map((state) => (
        <Card key={state}>
          <CardHeader>
            <Row align="center" gap="sm">
              <CardTitle as="h2">
                {IMPORT_RUN_TARGET_STATE_LABEL[state]}
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {groups.get(state)?.length}
              </span>
            </Row>
          </CardHeader>
          <CardContent>
            <Grid cols="thumbs" gap="md">
              {groups.get(state)?.map((runImage) => (
                <PhotoTargetCard key={runImage.id} runImage={runImage} />
              ))}
            </Grid>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

/** The photo-inventory counterpart of the purchase-agent run detail: a
 * grouped worklist of the run's images rather than an agent transcript. */
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
      <PhotoRunTargets run={run} />
    </Stack>
  );
}
