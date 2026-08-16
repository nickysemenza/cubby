import { locationShortcode } from "@cubby/schemas/identifiers";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Suspense } from "react";
import { z } from "zod";
import { ArrangeSurface } from "~/app/locations/arrange/ArrangeSurface";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  view: z.enum(["board", "tree"]).optional().catch(undefined),
  /**
   * The drilled-to location. Both views derive their whole position from it —
   * the board's column path and the tree's zoom are each the root→node chain
   * `pathToNode` rebuilds from this one id, so the URL stays a single token and
   * switching views keeps your place.
   */
  at: locationShortcode.optional().catch(undefined),
});

const searchDefaults = { view: undefined, at: undefined } as const;

export const Route = createFileRoute("/_authenticated/locations/arrange")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
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
  const { view = "board", at } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Page variant="list" title="Arrange" eyebrow="Locations" fullWidth>
      <Suspense fallback={<SimpleLoading text="Loading locations..." />}>
        <ArrangeSurface
          view={view}
          onViewChange={(v) =>
            navigate({ search: (prev) => ({ ...prev, view: v }) })
          }
          at={at}
          // replace: drilling shouldn't build a back-stack you have to unwind a
          // column at a time — back should leave the page.
          onSelect={(next) =>
            navigate({
              search: (prev) => ({ ...prev, at: next }),
              replace: true,
            })
          }
        />
      </Suspense>
    </Page>
  );
}
