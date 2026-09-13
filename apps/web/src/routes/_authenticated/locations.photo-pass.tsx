import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { photoPassSearchSchema } from "~/app/locations/photo-pass/photo-pass-search";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { pageTitle } from "~/lib/page-title";

/**
 * Lazy on purpose. TanStack's generated route tree statically imports every
 * route module, so anything a route pulls in lands in the client's EAGER
 * closure. This route drags in the QR scanner and the location picker for a
 * surface almost nobody opens
 * on a cold load, so it pays for itself only when actually visited.
 */
const PhotoPassWorkbench = lazy(() =>
  import("~/app/locations/photo-pass/PhotoPassWorkbench").then((m) => ({
    default: m.PhotoPassWorkbench,
  })),
);

const searchDefaults = {
  parent: undefined,
  scope: undefined,
  all: undefined,
  type: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/locations/photo-pass")({
  validateSearch: photoPassSearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: PhotoPassPage,
  head: () => ({ meta: [{ title: pageTitle("Photo pass") }] }),
});

function PhotoPassPage() {
  const search = Route.useSearch();

  return (
    <Page
      variant="list"
      title="Photo pass"
      eyebrow="Locations"
      compact
      decoration="none"
    >
      <Suspense fallback={<SimpleLoading text="Loading photo pass..." />}>
        <PhotoPassWorkbench {...search} />
      </Suspense>
    </Page>
  );
}
