import { unsafeLocationId } from "@cubby/schemas/identifiers";
import { formatDistanceToNow } from "date-fns";
import { Calendar } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CardThumbnail } from "~/components/entity/card-thumbnail";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { EmptyLocation } from "~/server/repo/problems";
import { AddInventoryDialog } from "./add-inventory-dialog";
import { ProblemSection } from "./problem-section";
import { createdAgoDetail } from "./render-helpers";

export function EmptyLocationsList({
  locations,
}: {
  locations: EmptyLocation[];
}) {
  const [addDialogLocation, setAddDialogLocation] =
    useState<EmptyLocation | null>(null);

  return (
    <>
      <ProblemSection
        title="Empty Locations"
        description="Leaf locations with no inventory entries. Consider adding inventory or removing unused locations."
        entity="location"
        items={locations}
        emptyMessage="All leaf locations have inventory entries."
        renderItem={(location) => {
          const details: ReactNode[] = [];

          if (location.aiDescription) {
            details.push(
              <p
                key="ai-desc"
                className="line-clamp-2 text-muted-foreground text-sm"
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
                className="text-muted-foreground text-sm"
              >
                <Calendar className="size-3" />
                Last inventory {formatDistanceToNow(location.lastBulkInventory)}{" "}
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
                to="/locations/$id"
                params={{ id: location.id }}
              />
            ),
            badges: [
              <Badge key="type" variant="outline" className="capitalize">
                {location.type}
              </Badge>,
            ],
            details,
            route: {
              to: "/locations/$id" as const,
              params: { id: location.id },
            },
            editLabel: "View",
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
          locationId={unsafeLocationId(addDialogLocation.id)}
          locationName={addDialogLocation.name}
          onSuccess={() => undefined}
        />
      )}
    </>
  );
}
