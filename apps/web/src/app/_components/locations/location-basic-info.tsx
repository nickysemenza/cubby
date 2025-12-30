import { Link } from "@tanstack/react-router";
import type { FC } from "react";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Button } from "~/components/ui/button";
import type { InfLocation } from "~/schemas/location";
import { EntityPillLink } from "../EntityPill";
import { LocationTypeBadge } from "./LocationTypeBadge";
import { LocationIconWithLabel } from "./location-icons";

interface LocationBasicInfoProps {
  location: InfLocation;
  onEdit: () => void;
}

export const LocationBasicInfo: FC<LocationBasicInfoProps> = ({
  location,
  onEdit,
}) => {
  const fields: BasicInfoField[] = [
    { label: "Type", value: <LocationTypeBadge type={location.type} /> },
    {
      label: "Parent Location",
      value: location.parent ? (
        <EntityPillLink entity="location" data={location.parent} />
      ) : undefined,
    },
  ];

  return (
    <BasicInfo
      fields={fields}
      header={
        <div className="flex items-center gap-3">
          <LocationIconWithLabel
            type={location.type}
            label={location.name}
            size={20}
          />
        </div>
      }
      actions={
        <div className="flex gap-2">
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
      }
    />
  );
};
