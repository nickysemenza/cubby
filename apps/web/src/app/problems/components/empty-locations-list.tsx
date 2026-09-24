import type { EmptyLocation } from "@cubby/schemas/problems";
import { CalendarIcon } from "@phosphor-icons/react/dist/csr/Calendar";
import { formatDistanceToNow } from "date-fns";
import { type ReactNode, useState } from "react";

import { CardThumbnail } from "~/components/entity/card-thumbnail";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { entityDetailLink } from "~/entities/entities";

import { AddInventoryDialog } from "./add-inventory-dialog";
import { ProblemSection, type ProblemSectionCoverage } from "./problem-section";
import { createdAgoDetail } from "./render-helpers";

export function EmptyLocationsList({
  locations,
  coverage,
  count,
  assembly,
}: {
  locations: EmptyLocation[];
  coverage?: ProblemSectionCoverage;
  /** True population — `locations` is a page of it. */
  count?: number;
  assembly?: ReactNode;
}) {
  const [addDialogLocation, setAddDialogLocation] =
    useState<EmptyLocation | null>(null);

  return (
    <>
      <ProblemSection
        title="Empty Locations"
        description="Leaf locations holding no inventory entries. Many are deliberate — a crate of zip ties is photographed and described rather than itemized — so treat this as how much of the house is itemized, not as a list of mistakes."
        entity="location"
        items={locations}
        count={count}
        assembly={assembly}
        coverage={coverage}
        emptyMessage="All leaf locations have inventory entries."
        renderItem={(location) => {
          const details: ReactNode[] = [];

          if (location.aiDescription) {
            details.push(
              <p
                key="ai-desc"
                className="line-clamp-2 text-sm text-muted-foreground"
              >
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
                Last inventory {formatDistanceToNow(
                  location.lastBulkInventory,
                )}{" "}
                ago
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
              <CardThumbnail
                images={images}
                alt={location.name}
                to="/locations/$shortcode"
                params={{ shortcode: location.id }}
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
              <Button size="sm" onClick={() => setAddDialogLocation(location)}>
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
