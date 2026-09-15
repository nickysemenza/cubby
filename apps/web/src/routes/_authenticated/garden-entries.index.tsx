import { locationShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { EntryForm } from "~/app/garden/entry-form";
import { GardenDialogFooterSlot } from "~/app/garden/garden-fields";
import { gardenStrings } from "~/app/garden/garden-strings";
import { GardenTimeline } from "~/app/garden/garden-timeline";
import { Stack } from "~/components/layout";
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
  const areaTitle = location.data
    ? `${location.data.name} journal`
    : "Garden journal";
  return (
    <Page
      variant="list"
      title={areaTitle}
      decoration="none"
      // The breadcrumb is the only way back to the garden on a phone.
      mobileTitleVisible
      eyebrow={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>House</span>
          <span aria-hidden className="text-border">
            /
          </span>
          <Link
            to="/garden"
            className="transition-colors hover:text-foreground"
          >
            Garden
          </Link>
          <span aria-hidden className="text-border">
            /
          </span>
          <span>{areaTitle}</span>
        </span>
      }
    >
      <Stack gap="lg">
        {locationId && (
          <Button onClick={() => setAdding(true)} className="self-start">
            {gardenStrings.home.logEntry}
          </Button>
        )}
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
