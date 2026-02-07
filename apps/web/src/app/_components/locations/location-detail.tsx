import type { InfLocation, LocationUpdateInput } from "@cubby/schemas/location";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ClipboardCheck,
  DollarSign,
  FolderTree,
  ImageIcon,
  Info,
  Package,
  Plus,
  Printer,
  ScanBarcode,
} from "lucide-react";
import { type FC, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "~/lib/utils";
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
import { typeSupportsQrCode } from "./location-type-theme";

interface LocationDetailProps {
  location: InfLocation;
}

export const LocationDetail: FC<LocationDetailProps> = ({ location }) => {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateChildOpen(true)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Child
            </Button>
            {location.children && location.children.length > 0 && (
              <>
                <Link
                  to="/locations/validate"
                  search={{ parentId: location.id }}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                  )}
                >
                  <ClipboardCheck className="mr-2 h-4 w-4" />
                  Validate
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const children = location.children!;
                    const eligible = children.filter(
                      (c) => c.shortcode && typeSupportsQrCode(c.type),
                    );
                    const skipped = children.length - eligible.length;

                    if (eligible.length === 0) {
                      toast.error(
                        "None of the child locations support QR code labels (rooms and areas are excluded)",
                      );
                      return;
                    }

                    if (skipped > 0) {
                      toast.info(
                        `Skipped ${skipped} location${skipped === 1 ? "" : "s"} without QR support (rooms/areas)`,
                      );
                    }

                    const codes = eligible.map((c) => c.shortcode).join(",");
                    void navigate({ to: "/labels", search: { codes } });
                  }}
                >
                  <Printer className="mr-2 h-4 w-4" />
                  Print Labels
                </Button>
              </>
            )}
          </div>
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
              to="/inventory/quick-capture"
              search={{ locationId: location.id, scanner: true }}
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
