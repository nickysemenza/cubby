import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Camera, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ScannerForm } from "~/app/_components/inventory/scanner-form";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { FilterableCombobox } from "~/components/ui/combobox";
import { getErrorMessage } from "~/lib/error-utils";
import { unsafeLocationId } from "~/schemas/identifiers";
import { useTRPC } from "~/trpc/react";

const searchSchema = z.object({
  locationId: z.string().optional(),
});

export const Route = createFileRoute("/inventory/scanner")({
  validateSearch: searchSchema,
  component: ScannerPage,
});

function ScannerPage() {
  const { locationId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { trpc } = Route.useRouteContext();
  const api = useTRPC();
  const queryClient = useQueryClient();

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

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

  // Mutations for image upload
  const uploadImageMutation = useMutation(
    api.image.uploadImage.mutationOptions(),
  );
  const updateLocationMutation = useMutation(
    api.location.update.mutationOptions(),
  );

  const handleCameraCapture = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file || !locationId) return;

    setIsUploading(true);
    try {
      // Step 1: Get presigned URL
      const result = await uploadImageMutation.mutateAsync({
        filename: file.name,
        contentType: file.type,
        size: file.size,
        entityType: "LOCATION",
      });

      // Step 2: Upload to storage
      try {
        const uploadResponse = await fetch(result.uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });

        if (!uploadResponse.ok) {
          const errorText = await uploadResponse.text().catch(() => "");
          throw new Error(
            `Storage upload failed (${uploadResponse.status}): ${errorText}`,
          );
        }
      } catch (fetchError) {
        // CORS or network error
        console.error("Storage upload error:", fetchError);
        throw new Error(
          `Storage upload failed - check CORS settings: ${getErrorMessage(fetchError)}`,
        );
      }

      // Step 3: Attach to location
      await updateLocationMutation.mutateAsync({
        id: unsafeLocationId(locationId),
        data: { pendingImageIds: [result.imageId] },
      });

      // Refresh location data
      await queryClient.invalidateQueries({
        queryKey: trpc.location.getByID.queryKey({ id: locationId }),
      });

      toast.success("Photo added to location");
    } catch (error) {
      console.error("Photo upload error:", error);
      toast.error(`Failed to upload photo: ${getErrorMessage(error)}`);
    } finally {
      setIsUploading(false);
      // Reset input so same file can be selected again
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

  return (
    <PageWrapper>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" onClick={handleBack}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div className="flex-1">
                <CardTitle>Scanner</CardTitle>
                <CardDescription>
                  Scan barcodes or type product names to add inventory
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-full sm:w-64">
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
                  >
                    {isUploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Camera className="h-4 w-4" />
                    )}
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {locationId && selectedLocation ? (
            <ScannerForm
              locationId={unsafeLocationId(locationId)}
              locationName={selectedLocation.name}
            />
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              Select a location to start scanning
            </div>
          )}
        </CardContent>
      </Card>
    </PageWrapper>
  );
}
