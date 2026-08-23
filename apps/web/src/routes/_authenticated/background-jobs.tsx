import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { BackgroundJobsPage } from "~/app/_components/background-jobs/background-jobs-page";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  batchId: z.string().optional(),
  // Plural scope set by the save toast: the page narrows its batch list to just
  // these ids so one toast link opens exactly that mutation's batches. `batchId`
  // (singular) still drives the detail panel.
  batchIds: z.array(z.string()).optional(),
});

export const Route = createFileRoute("/_authenticated/background-jobs")({
  validateSearch: searchSchema,
  component: BackgroundJobsRoute,
  head: () => ({ meta: [{ title: pageTitle("Background jobs") }] }),
});

function BackgroundJobsRoute() {
  const { batchId, batchIds } = Route.useSearch();
  return (
    <Page variant="list" title="Background jobs" listChrome="workbench">
      <BackgroundJobsPage selectedBatchId={batchId} scopedBatchIds={batchIds} />
    </Page>
  );
}
