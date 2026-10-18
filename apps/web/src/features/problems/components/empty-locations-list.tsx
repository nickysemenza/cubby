import { ProblemItem } from "@cubby/schemas/problems";
import { CalendarIcon } from "@phosphor-icons/react/dist/csr/Calendar";
import { type ReactNode, useState } from "react";

import { EntityCover } from "~/entity/components/entity-cover";
import { entityDetailLink } from "~/entity/entities";
import { DateDisplay } from "~/ui/common/date-display";
import { Row } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";

import { AddInventoryDialog } from "./add-inventory-dialog";
import {
  ProblemSection,
  type ProblemSectionContext,
  type ProblemSectionCoverage,
} from "./problem-section";
import { createdAgoDetail } from "./render-helpers";

export function EmptyLocationsList({
  locations,
  coverage,
  count,
  emptyMessage,
  context,
}: {
  locations: ProblemItem<"emptyLocations">[];
  coverage?: ProblemSectionCoverage;
  /** True population — `locations` is a page of it. */
  count: number;
  emptyMessage: string;
  context: ProblemSectionContext;
}) {
  const [addDialogLocation, setAddDialogLocation] =
    useState<ProblemItem<"emptyLocations"> | null>(null);

  return (
    <>
      <ProblemSection
        items={locations}
        count={count}
        assembly={context.assembly}
        listHref={context.listHref}
        warning={context.warning}
        coverage={coverage}
        emptyMessage={emptyMessage}
        renderItem={(location) => {
          const details: ReactNode[] = [];

          if (location.aiDescription) {
            details.push(
              <p key="ai-desc" className="line-clamp-2 text-muted-foreground">
                {location.aiDescription}
              </p>,
            );
          }

          details.push(createdAgoDetail(location.createdAt));

          if (location.lastBulkInventory) {
            details.push(
              <Row
                key="last-inventory"
                align="center"
                gap="xs"
                className="text-sm text-muted-foreground"
              >
                <CalendarIcon className="size-3" />
                Last inventory{" "}
                <DateDisplay timestamp={location.lastBulkInventory} />
              </Row>,
            );
          }

          const images =
            location.firstImageUrl && location.firstImageId
              ? [{ id: location.firstImageId, url: location.firstImageUrl }]
              : [];

          return {
            title: location.name,
            imageSlot: (
              <EntityCover
                images={images}
                alt={location.name}
                size={32}
                to="/locations/$shortcode"
                params={{ shortcode: location.id }}
                preview
                lazyPreview
                placeholder="none"
              />
            ),
            badges: [
              <Badge key="type" variant="outline" className="capitalize">
                {location.type}
              </Badge>,
            ],
            details,
            route: entityDetailLink("location", location.id),
            customActions: (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAddDialogLocation(location)}
              >
                Add Inventory
              </Button>
            ),
          };
        }}
      />
      {addDialogLocation && (
        <AddInventoryDialog
          open={!!addDialogLocation}
          onOpenChange={(open) => {
            if (!open) setAddDialogLocation(null);
          }}
          locationId={addDialogLocation.id}
          locationName={addDialogLocation.name}
          onSuccess={() => undefined}
        />
      )}
    </>
  );
}
