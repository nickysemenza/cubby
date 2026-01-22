import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  DollarSign,
  FolderTree,
  ImageIcon,
  Info,
  Package,
  Plus,
  ScanBarcode,
} from "lucide-react";
import { type FC, useState } from "react";
import { Button, buttonVariants } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "~/lib/utils";
import type { InfLocation, LocationUpdateInput } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { DetailPage, type DetailSection } from "../data-table/detail-page";
import EntityImageList from "../EntityImageList";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { QuickInventoryAdd } from "../inventory/quick-inventory-add";
import { CreateChildLocationDialog } from "./create-child-location-dialog";
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
  const queryClient = useQueryClient();
  const [createChildOpen, setCreateChildOpen] = useState(false);

  const { commonSections, editMode } = useEntityDetail<
    InfLocation,
    LocationUpdateInput
  >({
    entity: "location",
    data: location,
    mutationOptions: api.location.update.mutationOptions(),
  });

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
      content: (
        <div className="space-y-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateChildOpen(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Child
          </Button>
          {location.children && location.children.length > 0 ? (
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
          )}
        </div>
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
                onSuccess={() => {
                  void queryClient.invalidateQueries({
                    queryKey: [queryKeys.inventory.list],
                  });
                }}
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
          <LocationInventoryTable locationId={location.id} />
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
      <CreateChildLocationDialog
        open={createChildOpen}
        onOpenChange={setCreateChildOpen}
        parentLocation={location}
        onSuccess={() => {
          void queryClient.invalidateQueries({
            queryKey: api.location.getByID.queryKey({ id: location.id }),
          });
        }}
      />
    </>
  );
};
