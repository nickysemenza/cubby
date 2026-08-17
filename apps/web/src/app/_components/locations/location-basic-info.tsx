import type { InfLocation } from "@cubby/schemas/location";
import type { FC } from "react";
import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
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
    entity: "location",
    mutationOptions: (callbacks) =>
      api.location.delete.mutationOptions(callbacks),
    invalidateKeys: locationMutationInvalidateKeys,
    redirectTo: "/locations",
  });

  const fields: BasicInfoField[] = [
    // Shortcode (if assigned)
    ...(location.id
      ? [
          {
            label: "Shortcode",
            value: (
              <Badge variant="secondary" className="font-mono">
                {location.id}
              </Badge>
            ),
          },
        ]
      : []),
    // A location that IS a Product has no type of its own — the SKU is its form
    // factor. Showing an empty "Type" row was the tell that this page still
    // only knew how to render the productless half.
    location.product
      ? {
          label: "Is a",
          value: <EntityInlineLink entity="product" data={location.product} />,
        }
      : {
          label: "Type",
          value: <LocationTypeLabel type={location.type} product={null} />,
        },
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
              product={location.product}
              label={location.name}
              size={20}
            />
          </div>
        }
        actions={
          // Contents operations (recount, bulk edit) live on the Contents
          // toolbar now — this cluster is location-record actions only.
          <Row gap="sm" wrap>
            <DetailEditAction onClick={onEdit} />
            {typeSupportsQrCode(location.type) && (
              <PrintLabelButton shortcode={location.id} />
            )}
            {deleteButton}
          </Row>
        }
      />
      {deleteDialog}
    </>
  );
};
