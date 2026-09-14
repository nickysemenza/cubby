import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarDays } from "lucide-react";
import { useState } from "react";

import { DetailSections } from "~/app/_components/data-table/detail-page";
import { EntryForm } from "~/app/garden/entry-form";
import { GardenDialogFooterSlot } from "~/app/garden/garden-fields";
import { GardenEntryContent } from "~/app/garden/garden-timeline";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

export const Route = createFileRoute(
  "/_authenticated/garden-entries/$shortcode",
)({
  component: GardenEntryPage,
  errorComponent: RouteErrorComponent,
  head: shortcodeHead,
});
function GardenEntryPage() {
  const { shortcode } = Route.useParams();
  const entry = useQuery(
    entityDetailFor("gardenEntry").queryOptions(shortcode),
  );
  const [editing, setEditing] = useState(false);
  if (entry.isPending) return <p>Loading garden entry…</p>;
  if (entry.isError) throw entry.error;
  return (
    <Page variant="detail" title="Garden entry" entity="gardenEntry">
      {entry.data ? (
        <>
          <DetailSections
            rawData={entry.data}
            showEntityActions={false}
            sections={[
              {
                id: "observation",
                title: "Observation",
                icon: CalendarDays,
                placement: "primary",
                content: <GardenEntryContent entry={entry.data} />,
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
                entry={entry.data}
                locationId={entry.data.locationId}
                onSaved={() => {
                  setEditing(false);
                  void entry.refetch();
                }}
                onCancel={() => setEditing(false)}
              />
            </ResponsiveDialog>
          )}
        </>
      ) : (
        <p>Garden entry not found.</p>
      )}
    </Page>
  );
}
