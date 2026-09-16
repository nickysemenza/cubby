import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarDays } from "lucide-react";
import { useState } from "react";

import { DetailSections } from "~/app/_components/data-table/detail-page";
import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { EntryForm } from "~/app/garden/entry-form";
import { GardenDialogFooterSlot } from "~/app/garden/garden-fields";
import { gardenEntryKindLabel } from "~/app/garden/garden-photos";
import { GardenEntryContent } from "~/app/garden/garden-timeline";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { shortcodeHead } from "~/lib/page-title";

/**
 * Holds the hooks for the garden entry detail body. `detailPage`'s `render`
 * callback runs inside `EntityDetailPage`'s function-component body, but it
 * is an anonymous callback, not a component — hooks belong in a real
 * component the callback returns, mirroring `purchases.$shortcode.tsx` /
 * `plantings.$shortcode.tsx`.
 */
function GardenEntryDetailRoute({
  entry,
  shortcode,
}: {
  entry: EntityDetailByEntity["gardenEntry"];
  shortcode: string;
}) {
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  return (
    <Page
      variant="detail"
      entity="gardenEntry"
      title={entry.displayName}
      rawData={entry}
      heroImages={entry.images}
      heroNo={entry.id}
    >
      <DetailSections
        rawData={entry}
        showEntityActions={false}
        sections={[
          {
            id: "entry",
            title: gardenEntryKindLabel(entry.kind),
            icon: CalendarDays,
            placement: "primary",
            content: <GardenEntryContent entry={entry} />,
            headerAction: (
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit entry
              </Button>
            ),
          },
        ]}
      />
      {editing && (
        <ResponsiveDialog
          open
          onOpenChange={setEditing}
          title="Edit garden entry"
          size="lg"
          footer={<GardenDialogFooterSlot />}
        >
          <EntryForm
            key={shortcode}
            entry={entry}
            locationId={entry.locationId}
            onSaved={() => {
              setEditing(false);
              void invalidateOperationTags(queryClient, ripple.gardenEntry);
            }}
            onCancel={() => setEditing(false)}
          />
        </ResponsiveDialog>
      )}
    </Page>
  );
}

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const GardenEntryDetailPage = detailPage({
  query: (shortcode) => entityDetailFor("gardenEntry").queryOptions(shortcode),
  render: (entry, shortcode) => (
    <GardenEntryDetailRoute entry={entry} shortcode={shortcode} />
  ),
  title: (entry) => entry.displayName,
});

const GardenEntryNotFound = notFoundPage("gardenEntry");

export const Route = createFileRoute(
  "/_authenticated/garden-entries/$shortcode",
)({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("gardenEntry").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: GardenEntryNotFound,
  head: shortcodeHead,
  component: GardenEntryDetailPage,
});
