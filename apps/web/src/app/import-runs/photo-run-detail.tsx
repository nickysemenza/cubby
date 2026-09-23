import type { ImportRunTargetState } from "@cubby/schemas/purchase-import";

import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
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
  return (
    <Stack gap="lg">
      <PhotoRunProgress run={run} />
      <PhotoGroupReview runId={run.publicId} runStatus={run.status} />
    </Stack>
  );
}
