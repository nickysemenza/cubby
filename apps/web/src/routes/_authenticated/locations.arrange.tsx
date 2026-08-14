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
  // Client-only: ArrangeSurface suspends on `location.makeTree`, so the server
  // render fetches it through the SSR tRPC client — which self-fetches
  // `http://localhost:PORT/api/trpc`. That is unauthenticated in dev and, on CF
  // Workers, never reaches the app at all: the edge answers with the plain-text
  // body `error code: 1003`, so parsing the response throws
  // `Unexpected token 'e' ... is not valid JSON` into the route error boundary
  // on any direct load of this URL. Matches every other suspense-query route.
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
