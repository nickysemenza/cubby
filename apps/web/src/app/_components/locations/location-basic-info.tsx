import type { InfLocation } from "@cubby/schemas/location";
import type { FC } from "react";
import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { locationMutationInvalidateKeys } from "~/lib/query-keys";
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
  const { deleteButton, deleteDialog } = useEntityDelete({
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
    {
      // Tenet 1: inventory truth here is only as good as the last deliberate
      // recount. The hint tints warning once that's gone stale (>30d).
      label: "Last recount",
      value: <AuditedHint at={location.lastBulkInventory} label="recounted" />,
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
          // Contents operations (recount, bulk edit) live on the Contents
          // toolbar now — this cluster is location-record actions only.
          <Row gap="sm" wrap>
            <Button onClick={onEdit}>Edit</Button>
            {typeSupportsQrCode(location.type) && (
              <PrintLabelButton shortcode={location.shortcode} />
            )}
            {deleteButton}
          </Row>
        }
      />
      {deleteDialog}
    </>
  );
};
