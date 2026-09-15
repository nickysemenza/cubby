import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { PlantingDetail } from "~/app/garden/planting-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { shortcodeHead } from "~/lib/page-title";

/**
 * Holds the hooks for the planting detail body. `detailPage`'s `render`
 * callback runs inside `EntityDetailPage`'s function-component body, but it
 * is an anonymous callback, not a component — hooks belong in a real
 * component the callback returns, mirroring `purchases.$shortcode.tsx` /
 * `garden-entries.$shortcode.tsx`.
 */
function PlantingDetailRoute({
  planting,
}: {
  planting: EntityDetailByEntity["planting"];
}) {
  const queryClient = useQueryClient();
  return (
    <Page
      variant="detail"
      entity="planting"
      title={planting.displayName}
      rawData={planting}
      heroImages={planting.images}
      heroNo={planting.id}
    >
      <PlantingDetail
        key={planting.id}
        planting={planting}
        refresh={() =>
          void invalidateOperationTags(queryClient, ripple.planting)
        }
      />
    </Page>
  );
}

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const PlantingDetailPage = detailPage({
  query: (shortcode) => entityDetailFor("planting").queryOptions(shortcode),
  render: (planting) => <PlantingDetailRoute planting={planting} />,
  title: (planting) => planting.displayName,
});

const PlantingNotFound = notFoundPage(
  "planting",
  "Planting not found",
  "This planting is no longer available.",
);

export const Route = createFileRoute("/_authenticated/plantings/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("planting").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: PlantingNotFound,
  head: shortcodeHead,
  component: PlantingDetailPage,
});
