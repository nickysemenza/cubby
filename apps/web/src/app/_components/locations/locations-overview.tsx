"use client";
import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { EnhancedLocationTree } from "./enhanced-location-tree";
import { LocationCardGrid } from "./location-card-grid";
import { LocationInventoryPreview } from "./location-inventory-preview";
import { type InfLocation } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";

export function LocationsOverview() {
  const [selectedLocation, setSelectedLocation] = useState<
    InfLocation | undefined
  >();

  const api = useTRPC();
  const { data: locations, isLoading } = useQuery(
    api.location.makeTree.queryOptions(),
  );

  if (isLoading) {
    return <div>Loading locations...</div>;
  }

  if (!locations || locations.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Locations</h1>
          <p className="text-muted-foreground">No locations found</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Get Started</CardTitle>
            <CardDescription>
              Create your first location to begin organizing your space.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/locations/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New Location
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const getAllLocationsFlat = (locs: InfLocation[]): InfLocation[] => {
    const result: InfLocation[] = [];
    for (const loc of locs) {
      result.push(loc);
      if (loc.children) {
        result.push(...getAllLocationsFlat(loc.children));
      }
    }
    return result;
  };

  const allLocationsFlat = getAllLocationsFlat(locations);

  return (
    <div className="space-y-6">
      {/* Header with Stats */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Locations</h1>
          <p className="text-muted-foreground">
            {allLocationsFlat.length} total locations organized in{" "}
            {locations.length} top-level groups
          </p>
        </div>
        <Link href="/locations/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            New Location
          </Button>
        </Link>
      </div>

      {/* Tree View */}
      <div className="grid h-150 grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Location Tree</CardTitle>
            <CardDescription>Navigate your location hierarchy</CardDescription>
          </CardHeader>
          <CardContent className="h-250 p-0">
            <EnhancedLocationTree
              selectedLocationId={selectedLocation?.id}
              onLocationSelect={setSelectedLocation}
            />
          </CardContent>
        </Card>
        <Card className="overflow-auto lg:col-span-2">
          <CardHeader>
            <CardTitle>
              {selectedLocation ? selectedLocation.name : "Select a location"}
            </CardTitle>
            <CardDescription>
              {selectedLocation
                ? `${selectedLocation.type} location with ${selectedLocation.children?.length || 0} child locations`
                : "Choose a location from the tree to see details"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {selectedLocation ? (
              <>
                {/* Child Locations */}
                {selectedLocation.children &&
                selectedLocation.children.length > 0 ? (
                  <div className="space-y-3">
                    <h4 className="text-sm font-medium">Child Locations</h4>
                    <LocationCardGrid
                      locations={selectedLocation.children}
                      showParentPath={false}
                      onLocationSelect={setSelectedLocation}
                      maxColumns={2}
                    />
                  </div>
                ) : null}

                {/* Inventory Preview */}
                <LocationInventoryPreview location={selectedLocation} />
              </>
            ) : (
              <p className="text-muted-foreground">
                Select a location to see its details.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
