import { useQuery } from "@tanstack/react-query";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { maintenance } from "~/lib/maintenance.functions";

const STATES = [
  ["current", "Current"],
  ["pending", "Pending"],
  ["waiting", "Waiting for companion"],
  ["skipped", "Skipped"],
  ["failed", "Failed"],
  ["reviewNeeded", "Needs review"],
  ["remaining", "Not processed"],
] as const;

export function ImageProcessingMaintenance() {
  const result = useQuery(maintenance.imageProcessing.queryOptions());
  const batch = useActionMutation({
    mutationFn: maintenance.backfillImageProcessing.mutationOptions,
    success: (result) =>
      result.submissionId ? (
        <a
          className="underline"
          href={`/activity?view=runs&submissionId=${encodeURIComponent(result.submissionId)}`}
        >
          {result.scheduled} image work items scheduled — view submission
        </a>
      ) : (
        `${result.scheduled} image work items scheduled`
      ),
  });
  const configure = useActionMutation({
    mutationFn: maintenance.configureImageProcessing.mutationOptions,
    success: "Image processing settings saved",
  });
  return (
    <Stack gap="sm">
      <h3 className="text-sm font-medium">Image processing</h3>
      <p className="text-xs text-muted-foreground">
        Descriptions use the configured AI vision model. Transparent images wait
        for an available Apple companion. Originals are retained.
      </p>
      {result.isPending ? (
        <p>Loading image work…</p>
      ) : result.isError ? (
        <p role="alert">Could not load image work.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>State</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Background removal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {STATES.map(([key, label]) => (
                <TableRow key={key}>
                  <TableCell>{label}</TableCell>
                  <TableCell>{result.data.description[key]}</TableCell>
                  <TableCell>{result.data.cutout[key]}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={configure.isPending}
              onClick={() =>
                configure.mutate({
                  ...result.data.settings,
                  enabled: !result.data.settings.enabled,
                })
              }
            >
              {result.data.settings.enabled
                ? "Disable new upload processing"
                : "Enable new upload processing"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={configure.isPending}
              onClick={() =>
                configure.mutate({
                  ...result.data.settings,
                  paused: !result.data.settings.paused,
                })
              }
            >
              {result.data.settings.paused
                ? "Resume queued work"
                : "Pause queued work"}
            </Button>
            <Button
              size="sm"
              disabled={batch.isPending || result.data.settings.paused}
              onClick={() =>
                batch.mutate({ batchSize: 25, retryFailures: false })
              }
            >
              Process next 25 images
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={batch.isPending || result.data.settings.paused}
              onClick={() =>
                batch.mutate({ batchSize: 25, retryFailures: true })
              }
            >
              Retry up to 25 failures
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pausing prevents new claims. Work already running may finish.
          </p>
        </>
      )}
    </Stack>
  );
}
