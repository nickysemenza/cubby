import { activityRunId } from "@cubby/schemas/activity";
import { createFileRoute, Link } from "@tanstack/react-router";

import { ActivityRunDetail } from "~/app/activity/activity-run-detail";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/runs/jobs/$id")({
  parseParams: (params) => ({ id: activityRunId.parse(params.id) }),
  head: () => ({ meta: [{ title: pageTitle("Image job") }] }),
  component: ImageJobDetailPage,
});

function ImageJobDetailPage() {
  const { id } = Route.useParams();
  return (
    <main className="mx-auto w-full max-w-4xl p-4">
      <Link to="/runs" className="text-primary hover:underline">
        ← Runs
      </Link>
      <ActivityRunDetail id={id} onClose={() => history.back()} />
    </main>
  );
}
