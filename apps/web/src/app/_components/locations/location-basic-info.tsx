import { Link } from "@tanstack/react-router";
import type { FC } from "react";
import { Button } from "~/components/ui/button";
import type { InfLocation } from "~/schemas/location";
import { LocationPillLink } from "../EntityPill";
import { NoneState } from "../NoneState";
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
      <div>
        <span className="font-medium">Type:</span> {location.type}
      </div>
      <div>
        <span className="font-medium">Parent Location:</span>{" "}
        {location.parent ? (
          <LocationPillLink location={location.parent} />
        ) : (
          <NoneState />
        )}
      </div>
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
