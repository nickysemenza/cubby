import { useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import type { InfLocation, LocationUpdateInput } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import EntityImageList from "../EntityImageList";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { QuickInventoryAdd } from "../inventory/quick-inventory-add";
import { NoneState } from "../NoneState";
import { InventoryValueSummary } from "./inventory-value-summary";
import { LocationBasicInfo } from "./location-basic-info";
import { LocationCardGrid } from "./location-card-grid";
import { LocationForm } from "./location-form";
import { LocationInventoryTable } from "./location-inventory-table";

interface LocationDetailProps {
  location: InfLocation;
}

export const LocationDetail: FC<LocationDetailProps> = ({ location }) => {
  const api = useTRPC();

  const { commonSections, editMode } = useEntityDetail<
    InfLocation,
    LocationUpdateInput
  >({
    entity: "location",
    data: location,
    mutationOptions: api.location.update.mutationOptions(),
  });

  const { data: inventoryItemsData, refetch: refetchInventoryItems } = useQuery(
    api.inventoryItem.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 100 },
      filters: { locationIdFilter: location.id },
    }),
  );

  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      content: editMode.isEditing ? (
        <div className="container mx-auto py-10">
          <h1 className="mb-6 font-bold text-2xl">Edit Location</h1>
          <LocationForm
            mode="edit"
            entity={location}
            onEdit={editMode.handleEdit}
            isPending={editMode.isPending}
            error={editMode.error}
            onCancel={editMode.handleCancel}
          />
        </div>
      ) : (
        <LocationBasicInfo location={location} onEdit={editMode.startEditing} />
      ),
    },
    // Custom section: Inventory Value
    {
      title: "Inventory Value",
      content: (
        <div className="py-1">
          <InventoryValueSummary locationId={location.id} variant="full" />
        </div>
      ),
    },
    // Custom section: Images (positioned before child locations)
    {
      title: "Images",
      content: <EntityImageList images={location.images ?? []} />,
    },
    // Custom section: Child Locations
    {
      title: "Child Locations",
      content:
        location.children && location.children.length > 0 ? (
          <LocationCardGrid
            locations={location.children}
            showParentPath={false}
          />
        ) : (
          <NoneState />
        ),
    },
    // Custom section: Inventory Items (with interactive refetch)
    {
      title: "Inventory Items",
      content: (
        <div className="space-y-4">
          <QuickInventoryAdd
            locationId={location.id}
            onSuccess={() => refetchInventoryItems()}
          />
          <LocationInventoryTable
            locationId={location.id}
            inventoryItems={inventoryItemsData?.items ?? []}
            onRefresh={() => refetchInventoryItems()}
          />
        </div>
      ),
    },
    // Common sections from entity config (History)
    ...commonSections,
  ];

  return (
    <DetailPage
      sections={sections}
      entity="location"
      name={location.name}
      rawData={location}
    />
  );
};
