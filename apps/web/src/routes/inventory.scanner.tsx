import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Camera, Check } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { PersistentScanner } from "~/app/_components/inventory/persistent-scanner";
import { RecentLocations } from "~/app/_components/inventory/recent-locations";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Button } from "~/components/ui/button";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import type { ProductId } from "~/schemas/identifiers";
import { unsafeLocationId } from "~/schemas/identifiers";
import { useTRPC } from "~/trpc/react";

const searchSchema = z.object({
  locationId: z.string().optional(),
});

export const Route = createFileRoute("/inventory/scanner")({
  validateSearch: searchSchema,
  component: ScannerPage,
});

interface RecentItem {
  id: string;
  productName: string;
  timestamp: Date;
}

function ScannerPage() {
  const { locationId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { trpc } = Route.useRouteContext();
  const api = useTRPC();
  const queryClient = useQueryClient();

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);

  // Fetch all locations for the dropdown
  const { data: locationsData, isLoading: isLoadingLocations } = useQuery(
    trpc.location.list.queryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 100 },
    }),
  );

  // Fetch the selected location details if we have a locationId
  const { data: selectedLocation } = useQuery({
    ...trpc.location.getByID.queryOptions({ id: locationId ?? "" }),
    enabled: !!locationId,
  });

  // Mutations
  const uploadImageMutation = useMutation(
    api.image.uploadImage.mutationOptions(),
  );
  const updateLocationMutation = useMutation(
    api.location.update.mutationOptions(),
  );
  const findOrCreateByUPCMutation = useMutation(
    api.product.findOrCreateByUPC.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.product.list });
      },
    }),
  );
  const createInventoryMutation = useMutation(
    api.inventory.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list });
      },
    }),
  );

  // Add item to inventory
  const addInventory = useCallback(
    async (productId: ProductId, productName: string) => {
      if (!locationId) return;

      try {
        await createInventoryMutation.mutateAsync({
          productId,
          locationId: unsafeLocationId(locationId),
          amount: { value: 1, unit: "each" },
        });

        setRecentItems((prev) => [
          { id: crypto.randomUUID(), productName, timestamp: new Date() },
          ...prev.slice(0, 9),
        ]);

        toast.success(`Added: ${productName}`);
      } catch (error) {
        toast.error(`Failed to add: ${getErrorMessage(error)}`);
      }
    },
    [createInventoryMutation, locationId],
  );

  // Handle barcode scan
  const handleBarcodeScan = useCallback(
    async (barcode: string) => {
      if (!locationId) {
        toast.error("Select a location first");
        return;
      }

      try {
        const product = await findOrCreateByUPCMutation.mutateAsync({
          upc: barcode,
        });
        await addInventory(product.id, product.name);
      } catch (error) {
        toast.error(`UPC lookup failed: ${getErrorMessage(error)}`);
      }
    },
    [findOrCreateByUPCMutation, addInventory, locationId],
  );

  const handleCameraCapture = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file || !locationId) return;

    setIsUploading(true);
    try {
      const result = await uploadImageMutation.mutateAsync({
        filename: file.name,
        contentType: file.type,
        size: file.size,
        entityType: "LOCATION",
      });

      const uploadResponse = await fetch(result.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });

      if (!uploadResponse.ok) {
        throw new Error(`Storage upload failed (${uploadResponse.status})`);
      }

      await updateLocationMutation.mutateAsync({
        id: unsafeLocationId(locationId),
        data: { pendingImageIds: [result.imageId] },
      });

      await queryClient.invalidateQueries({
        queryKey: trpc.location.getByID.queryKey({ id: locationId }),
      });

      toast.success("Photo added to location");
    } catch (error) {
      toast.error(`Failed to upload photo: ${getErrorMessage(error)}`);
    } finally {
      setIsUploading(false);
      if (cameraInputRef.current) {
        cameraInputRef.current.value = "";
      }
    }
  };

  const handleLocationChange = (newLocationId: string | null) => {
    if (newLocationId) {
      navigate({ search: { locationId: newLocationId } });
    }
  };

  const handleBack = () => {
    if (locationId && selectedLocation) {
      navigate({ to: "/locations/$id", params: { id: locationId } });
    } else {
      navigate({ to: "/inventory" });
    }
  };

  const isPending =
    findOrCreateByUPCMutation.isPending || createInventoryMutation.isPending;

  return (
    <div className="-mx-4 -mt-4 flex min-h-[calc(100vh-8rem)] flex-col md:mx-0 md:mt-0">
      {/* Floating header with location picker */}
      <div className="sticky top-0 z-20 bg-background/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            className="shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <div className="flex-1">
            <FilterableCombobox
              items={
                locationsData?.items.map((location) => ({
                  value: location.id,
                  label: `${location.name} (${location.type})`,
                  icon: (
                    <LocationIcon
                      type={location.type}
                      size={14}
                      className="text-muted-foreground"
                    />
                  ),
                })) ?? []
              }
              value={locationId ?? null}
              onValueChange={handleLocationChange}
              placeholder="Select location..."
              disabled={isLoadingLocations}
            />
          </div>

          {/* Camera button for location photos */}
          {locationId && (
            <>
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleCameraCapture}
                hidden
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => cameraInputRef.current?.click()}
                disabled={isUploading}
                title="Take photo of location"
                className="shrink-0"
              >
                {isUploading ? <Spinner /> : <Camera className="h-4 w-4" />}
              </Button>
            </>
          )}
        </div>

        {/* Location name indicator */}
        {selectedLocation && (
          <div className="mt-1 text-center text-muted-foreground text-xs">
            Adding to{" "}
            <span className="font-medium text-foreground">
              {selectedLocation.name}
            </span>
          </div>
        )}
      </div>

      {/* Scanner view */}
      <div className="flex-1 px-3">
        {locationId ? (
          <>
            <PersistentScanner
              onScan={handleBarcodeScan}
              enabled={!!locationId && !isPending}
            />

            {/* Loading indicator during UPC lookup */}
            {isPending && (
              <div className="mt-2 flex items-center justify-center gap-2 text-muted-foreground text-sm">
                <Spinner />
                Looking up product...
              </div>
            )}
          </>
        ) : (
          <div className="flex aspect-square flex-col items-center justify-center gap-6 rounded-lg bg-muted p-6">
            <p className="text-center text-muted-foreground">
              Select a location to start scanning
            </p>
            <RecentLocations
              onSelect={(location) => handleLocationChange(location.id)}
            />
          </div>
        )}
      </div>

      {/* Recent items */}
      {recentItems.length > 0 && (
        <div className="border-t bg-background p-3">
          <h4 className="mb-2 font-medium text-sm">Recently Added</h4>
          <div className="flex flex-wrap gap-2">
            {recentItems.slice(0, 5).map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-1 text-green-800 text-xs dark:bg-green-900/30 dark:text-green-400"
              >
                <Check className="h-3 w-3" />
                <span className="max-w-[120px] truncate">
                  {item.productName}
                </span>
              </div>
            ))}
            {recentItems.length > 5 && (
              <span className="px-2 py-1 text-muted-foreground text-xs">
                +{recentItems.length - 5} more
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
