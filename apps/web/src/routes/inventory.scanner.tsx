import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
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
import { unsafeLocationId } from "~/schemas/identifiers";

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
            <div className="w-64">
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
