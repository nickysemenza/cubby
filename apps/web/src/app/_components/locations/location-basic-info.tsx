import { Link } from "@tanstack/react-router";
import type { FC } from "react";
import { InfoRow } from "~/components/common/info-row";
import { Button } from "~/components/ui/button";
import type { InfLocation } from "~/schemas/location";
import { EntityPillLink } from "../EntityPill";
import { LocationIconWithLabel } from "./location-icons";

interface LocationBasicInfoProps {
  location: InfLocation;
  onEdit: () => void;
}

export const LocationBasicInfo: FC<LocationBasicInfoProps> = ({
  location,
  onEdit,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <LocationIconWithLabel
          type={location.type}
          label={location.name}
          size={20}
        />
      </div>
      <InfoRow label="Type">{location.type}</InfoRow>
      <InfoRow label="Parent Location">
        {location.parent ? (
          <EntityPillLink entity="location" data={location.parent} />
        ) : undefined}
      </InfoRow>
      <div className="mt-4 flex gap-2">
        <Button onClick={onEdit}>Edit</Button>
        <Button
          variant="outline"
          render={
            <Link
              to="/inventory/quick-capture"
              search={{ locationId: location.id }}
            />
          }
          nativeButton={false}
        >
          Quick Capture Here
        </Button>
        <Button
          variant="outline"
          render={
            <Link
              to="/inventory/bulk-edit"
              search={{ locationId: location.id }}
            />
          }
          nativeButton={false}
        >
          Bulk Edit Inventory
        </Button>
      </div>
    </div>
  );
};
