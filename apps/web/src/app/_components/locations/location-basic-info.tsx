import type { InfLocation } from "@cubby/schemas/location";
import type { FC } from "react";

import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { Badge } from "~/components/ui/badge";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { EntityBasicInfo } from "~/entities/entity-display";

import { EntityInlineLink } from "../EntityInlineLink";
import { LocationIconWithLabel } from "./location-icons";
import { LocationTypeLabel } from "./LocationTypeLabel";

interface LocationBasicInfoProps {
  location: InfLocation;
  onEdit: () => void;
}

export const LocationBasicInfo: FC<LocationBasicInfoProps> = ({
  location,
  onEdit,
}) => {
  return (
    <EntityBasicInfo
      entity="location"
      record={location}
      overrides={{
        id: (record) => ({
          value: record.id ? (
            <Badge variant="secondary" className="font-mono">
              {record.id}
            </Badge>
          ) : undefined,
        }),
        type: (record) => ({
          value: record.product ? undefined : (
            <LocationTypeLabel type={record.type} product={null} />
          ),
          filterAction:
            record.product || !record.type ? undefined : (
              <EntityFilterLink
                to="/locations"
                search={{ view: "table", type: record.type }}
                label={`Show all ${record.type} locations`}
              />
            ),
        }),
        productId: (record) => ({
          value: record.product ? (
            <EntityInlineLink
              displayImage={undefined}
              entity="product"
              data={record.product}
            />
          ) : undefined,
          filterAction: record.product ? (
            <EntityFilterLink
              to="/locations"
              search={{ view: "table", product: record.product.id }}
              label={`Show all locations that are ${record.product.name}`}
            />
          ) : undefined,
        }),
        parentId: (record) => ({
          value: record.parent ? (
            <EntityInlineLink
              displayImage={undefined}
              entity="location"
              data={record.parent}
            />
          ) : undefined,
          filterAction: record.parent ? (
            <EntityFilterLink
              to="/locations"
              search={{ view: "table", parent: record.parent.id }}
              label={`Show all locations inside ${record.parent.name}`}
            />
          ) : undefined,
        }),
        lastBulkInventory: (record) => ({
          // Tenet 1: inventory truth here is only as good as the last deliberate
          // recount. The hint tints warning once that's gone stale (>30d).
          value: (
            <AuditedHint at={record.lastBulkInventory} label="recounted" />
          ),
        }),
      }}
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
        // toolbar now. Reusable record actions come from the shared detail
        // host, leaving only this authored edit control here.
        <DetailEditAction onClick={onEdit} />
      }
    />
  );
};
