import { useQuery } from "@tanstack/react-query";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { maintenance } from "~/integrations/tanstack-query/generated/catalog.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { StaticTable } from "~/ui/primitives/static-table";

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
          href={`/image-jobs?submissionId=${encodeURIComponent(result.submissionId)}`}
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
        <ErrorDisplay
          error={result.error}
          title="image work"
          onRetry={() => void result.refetch()}
        />
      ) : (
        <>
          <StaticTable
            rows={STATES}
            rowKey={([key]) => key}
            columns={[
              { id: "state", header: "State", cell: ([, label]) => label },
              {
                id: "description",
                header: "Description",
                cell: ([key]) => result.data.description[key],
              },
              {
                id: "cutout",
                header: "Background removal",
                cell: ([key]) => result.data.cutout[key],
              },
            ]}
          />
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
