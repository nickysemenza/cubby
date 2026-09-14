import { locationShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { EntryForm } from "~/app/garden/entry-form";
import { GardenDialogFooterSlot } from "~/app/garden/garden-fields";
import { GardenTimeline } from "~/app/garden/garden-timeline";
import { Row, Stack } from "~/components/layout";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/garden-entries/")({
  component: GardenEntriesPage,
  validateSearch: z.object({ locationId: locationShortcode.optional() }),
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: pageTitle("Garden entries") }] }),
});
function GardenEntriesPage() {
  const { locationId } = Route.useSearch();
  const [adding, setAdding] = useState(false);
  const location = useQuery(
    entityDetailFor("location").queryOptions(locationId ?? "", {
      enabled: Boolean(locationId),
    }),
  );
  return (
    <Page
      variant="list"
      title={location.data ? `${location.data.name} journal` : "Garden journal"}
      decoration="none"
    >
      <Stack gap="lg">
        <Row gap="md" wrap align="center">
          <Link to="/garden" className="text-sm underline">
            Garden
          </Link>
          {locationId && (
            <>
              <Link
                to="/locations/$shortcode"
                params={{ shortcode: locationId }}
                className="text-sm underline"
              >
                {location.data?.name ?? "Location details"}
              </Link>
              <Button onClick={() => setAdding(true)}>
                Add photos / Log entry
              </Button>
            </>
          )}
        </Row>
        <GardenTimeline locationId={locationId} />
      </Stack>
      {adding && locationId && (
        <ResponsiveDialog
          open
          title="Log garden entry"
          size="lg"
          onOpenChange={setAdding}
          footer={<GardenDialogFooterSlot />}
        >
          <EntryForm
            locationId={locationId}
            onCancel={() => setAdding(false)}
            onSaved={() => setAdding(false)}
          />
        </ResponsiveDialog>
      )}
    </Page>
  );
}
