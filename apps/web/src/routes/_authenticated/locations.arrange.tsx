import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
import { z } from "zod";
import { ArrangeSurface } from "~/app/locations/arrange/ArrangeSurface";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  view: z.enum(["board", "tree"]).optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/locations/arrange")({
  validateSearch: searchSchema,
  component: ArrangePage,
  head: () => ({ meta: [{ title: pageTitle("Arrange") }] }),
});

function ArrangePage() {
  const { view = "board" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Page variant="list" title="Arrange" eyebrow="Locations" fullWidth>
      <Suspense fallback={<SimpleLoading text="Loading locations..." />}>
        <ArrangeSurface
          view={view}
          onViewChange={(v) => navigate({ search: { view: v } })}
        />
      </Suspense>
    </Page>
  );
}
