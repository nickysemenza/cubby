import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { BackgroundJobsPage } from "~/app/_components/background-jobs/background-jobs-page";
import { Page } from "~/components/page/Page";

const searchSchema = z.object({
  batchId: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/background-jobs")({
  validateSearch: searchSchema,
  component: BackgroundJobsRoute,
  head: () => ({ meta: [{ title: "Background jobs | cubby" }] }),
});

function BackgroundJobsRoute() {
  const { batchId } = Route.useSearch();
  return (
    <Page variant="list" title="Background jobs" compact decoration="none">
      <BackgroundJobsPage selectedBatchId={batchId} />
    </Page>
  );
}
