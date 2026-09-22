import type { BackfillImageMetadataOut } from "@cubby/schemas/maintenance";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { maintenance } from "~/lib/maintenance.functions";
import { countLabel } from "~/lib/pluralize";

const STOPPED_LABEL = {
  complete: "no more candidates",
  limit: "batch limit reached — more may remain",
  no_progress: "nothing in the last batch could be read",
} satisfies Record<BackfillImageMetadataOut["stopped"], string>;

function ResultSummary({ result }: { result: BackfillImageMetadataOut }) {
  return (
    <span className="text-xs text-muted-foreground">
      Extracted {countLabel(result.extracted, "image")}
      {result.skipped > 0
        ? ` (${countLabel(result.skipped, "image")} skipped — missing bytes or already fresh)`
        : ""}{" "}
      of {countLabel(result.scanned, "image scanned")} (
      {STOPPED_LABEL[result.stopped]}, {result.remaining} still stale).
    </span>
  );
}

/**
 * Repairs `Image.metadataRevision` rows a lost queue wakeup left behind — the
 * "Settle now" card already republishes a page of these on demand; this is
 * the bounded loop for backfilling a larger backlog (e.g. right after this
 * feature's rollout, or a `IMAGE_METADATA_REVISION` bump). See
 * `image-metadata-backfill.service.ts`.
 */
export function ImageMetadataMaintenance() {
  const [lastResult, setLastResult] = useState<BackfillImageMetadataOut | null>(
    null,
  );
  const backfill = useMutation({
    ...maintenance.backfillImageMetadata.mutationOptions(),
    onSuccess: (result) => setLastResult(result),
  });

  return (
    <Stack gap="sm">
      <h3 className="text-sm font-medium">Image EXIF metadata</h3>
      <p className="text-xs text-muted-foreground">
        Reads each stale image's stored bytes for embedded capture date, GPS,
        and camera, and feeds it into capture-attribution derivation. Every
        upload already schedules this automatically — run this only to repair a
        backlog.
      </p>
      {lastResult && <ResultSummary result={lastResult} />}
      <Row gap="sm">
        <Button
          size="sm"
          disabled={backfill.isPending}
          onClick={() => backfill.mutate({ batchSize: 25, maxBatches: 20 })}
        >
          {backfill.isPending ? "Extracting…" : "Extract stale metadata"}
        </Button>
      </Row>
    </Stack>
  );
}
