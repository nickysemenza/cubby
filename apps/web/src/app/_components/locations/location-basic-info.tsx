import type { InfLocation } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import type { FC } from "react";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { locationMutationInvalidateKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import { EntityInlineLink } from "../EntityInlineLink";
import { useEntityDelete } from "../hooks/useEntityDelete";
import { PrintLabelButton } from "../print-label-button";
import { LocationTypeLabel } from "./LocationTypeLabel";
import { LocationIconWithLabel } from "./location-icons";
import { typeSupportsQrCode } from "./location-type-theme";

interface LocationBasicInfoProps {
  location: InfLocation;
  onEdit: () => void;
}

export const LocationBasicInfo: FC<LocationBasicInfoProps> = ({
  location,
  onEdit,
}) => {
  const api = useTRPC();
  const { DeleteButton, DeleteDialog } = useEntityDelete({
    id: location.id,
    name: location.name,
    entityLabel: "Location",
    mutationOptions: (callbacks) =>
      api.location.delete.mutationOptions(callbacks),
    invalidateKeys: locationMutationInvalidateKeys,
    redirectTo: "/locations",
  });

  const fields: BasicInfoField[] = [
    // Shortcode (if assigned)
    ...(location.shortcode
      ? [
          {
            label: "Shortcode",
            value: (
              <Badge variant="secondary" className="font-mono">
                {location.shortcode}
              </Badge>
            ),
          },
        ]
      : []),
    { label: "Type", value: <LocationTypeLabel type={location.type} /> },
    {
      label: "Parent Location",
      value: location.parent ? (
        <EntityInlineLink entity="location" data={location.parent} />
      ) : undefined,
    },
  ];

  return (
    <>
      <BasicInfo
        fields={fields}
        header={
          <div className="flex items-center gap-2">
            <LocationIconWithLabel
              type={location.type}
              label={location.name}
              size={20}
            />
          </div>
        }
        actions={
          <Row gap="sm" wrap>
            <Button onClick={onEdit}>Edit</Button>
            {typeSupportsQrCode(location.type) && (
              <PrintLabelButton shortcode={location.shortcode} />
            )}
            <Button
              variant="outline"
              render={
                <Link
                  to="/inventory/session"
                  search={{ parentId: location.id }}
                />
              }
              nativeButton={false}
            >
              Recount
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
            <DeleteButton />
          </Row>
        }
      />
      <DeleteDialog />
    </>
  );
};
