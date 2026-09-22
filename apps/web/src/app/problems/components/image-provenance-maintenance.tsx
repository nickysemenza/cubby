import type { ClassifyImageProvenanceOut } from "@cubby/schemas/maintenance";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { maintenance } from "~/lib/maintenance.functions";
import { countLabel } from "~/lib/pluralize";

const STOPPED_LABEL = {
  complete: "no more candidates",
  limit: "batch limit reached — more may remain",
  no_progress: "no rule matched the remaining candidates",
} satisfies Record<ClassifyImageProvenanceOut["stopped"], string>;

function ResultSummary({ result }: { result: ClassifyImageProvenanceOut }) {
  const ruleCounts = Object.entries(result.byRule).filter(
    ([, count]) => count > 0,
  );
  return (
    <Stack gap="tight" className="text-xs text-muted-foreground">
      <span>
        {result.dryRun ? "Would classify" : "Classified"}{" "}
        {countLabel(result.classified, "image")} by filename
        {result.capturedAtSeeded > 0
          ? `, seeded capture date on ${countLabel(result.capturedAtSeeded, "image")}`
          : ""}{" "}
        of {countLabel(result.scanned, "image scanned")} (
        {STOPPED_LABEL[result.stopped]}, {result.remaining} still unclassified).
      </span>
      {ruleCounts.length > 0 && (
        <span className="font-mono">
          {ruleCounts
            .map(([ruleId, count]) => `${ruleId}: ${count}`)
            .join(" · ")}
        </span>
      )}
    </Stack>
  );
}

/**
 * Filename/dimension provenance heuristics for images still `source =
 * unknown` (see `image-provenance-heuristics.ts`). Dry-run previews what
 * would change per rule before anyone commits it — the same "preview, then
 * apply" shape as `ImageProcessingMaintenance`'s siblings on this page.
 */
export function ImageProvenanceMaintenance() {
  const [lastResult, setLastResult] =
    useState<ClassifyImageProvenanceOut | null>(null);
  const classify = useMutation({
    ...maintenance.classifyImageProvenance.mutationOptions(),
    onSuccess: (result) => setLastResult(result),
  });

  return (
    <Stack gap="sm">
      <h3 className="text-sm font-medium">Image provenance</h3>
      <p className="text-xs text-muted-foreground">
        Guesses a still-unknown image&apos;s source from its filename and
        dimensions (legacy uploader, camera-roll naming, catalog markers,
        screenshot resolutions), and seeds a missing capture date from an
        on-device photo analysis. Preview first — apply writes the guesses.
      </p>
      {lastResult && <ResultSummary result={lastResult} />}
      <Row gap="sm">
        <Button
          size="sm"
          variant="outline"
          disabled={classify.isPending}
          onClick={() =>
            classify.mutate({ dryRun: true, batchSize: 25, maxBatches: 1 })
          }
        >
          Preview next 25
        </Button>
        <Button
          size="sm"
          disabled={classify.isPending}
          onClick={() =>
            classify.mutate({ dryRun: false, batchSize: 25, maxBatches: 20 })
          }
        >
          Apply
        </Button>
      </Row>
    </Stack>
  );
}
