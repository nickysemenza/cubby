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
  // Client-only for *cost*, not correctness — the local-link transport made the
  // server render work here, but this board dehydrates the whole location
  // forest: measured at 844 KB of HTML against 84 KB client-only, the largest
  // in the app by 2x. It is an interactive drag-and-drop surface behind auth
  // with no SEO value, reached mostly by in-app navigation (which skips SSR
  // anyway), so a skeleton-then-data cold load is the better trade. Revisit
  // with a CF CPU-time measurement if the board ever needs a faster first paint.
  ssr: false,
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
