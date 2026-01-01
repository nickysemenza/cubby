import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  DollarSign,
  FolderTree,
  ImageIcon,
  Info,
  Package,
  ScanBarcode,
} from "lucide-react";
import type { FC } from "react";
import { buttonVariants } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { cn } from "~/lib/utils";
import type { InfLocation, LocationUpdateInput } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import EntityImageList from "../EntityImageList";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { QuickInventoryAdd } from "../inventory/quick-inventory-add";
import { InventoryValuationSummary } from "./inventory-valuation-summary";
import { LocationBasicInfo } from "./location-basic-info";
import { LocationBreadcrumb } from "./location-breadcrumb";
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
    api.inventory.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 100 },
      filters: { locationIdFilter: location.id },
    }),
  );

  const sections: DetailSection[] = [
    {
      title: "Basic Information",
      icon: Info,
      content: editMode.isEditing ? (
        <LocationForm
          mode="edit"
          entity={location}
          onEdit={editMode.handleEdit}
          isPending={editMode.isPending}
          error={editMode.error}
          onCancel={editMode.handleCancel}
        />
      ) : (
        <LocationBasicInfo location={location} onEdit={editMode.startEditing} />
      ),
    },
    // Custom section: Inventory Valuation
    {
      title: "Inventory Valuation",
      icon: DollarSign,
      content: (
        <div className="py-1">
          <InventoryValuationSummary locationId={location.id} variant="full" />
        </div>
      ),
    },
    // Custom section: Images (positioned before child locations)
    {
      title: "Images",
      icon: ImageIcon,
      content: <EntityImageList images={location.images ?? []} />,
    },
    // Custom section: Child Locations
    {
      title: "Child Locations",
      icon: FolderTree,
      content:
        location.children && location.children.length > 0 ? (
          <LocationCardGrid
            locations={location.children}
            showParentPath={false}
          />
        ) : (
          <Empty variant="minimal" className="py-4">
            <EmptyMedia variant="icon">
              <FolderTree className="size-4" />
            </EmptyMedia>
            <EmptyTitle>No child locations</EmptyTitle>
            <EmptyDescription>
              This location has no sub-locations
            </EmptyDescription>
          </Empty>
        ),
    },
    // Custom section: Inventory Items (with interactive refetch)
    {
      title: "Inventory Items",
      icon: Package,
      content: (
        <div className="space-y-4">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <QuickInventoryAdd
                locationId={location.id}
                onSuccess={() => refetchInventoryItems()}
              />
            </div>
            <Link
              to="/inventory/scanner"
              search={{ locationId: location.id }}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              <ScanBarcode className="mr-2 h-4 w-4" />
              Scan Items
            </Link>
          </div>
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
    <>
      <LocationBreadcrumb location={location} linkable />
      <DetailPage
        sections={sections}
        entity="location"
        name={location.name}
        rawData={location}
      />
    </>
  );
};
