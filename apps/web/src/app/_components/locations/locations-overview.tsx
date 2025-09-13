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
import { type InfLocation } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { LayoutGrid, TreePine, Plus } from "lucide-react";
import Link from "next/link";

export function LocationsOverview() {
  const [selectedLocation, setSelectedLocation] = useState<
    InfLocation | undefined
  >();
  const [viewMode, setViewMode] = useState<"grid" | "tree">("grid");

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
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border">
            <Button
              variant={viewMode === "grid" ? "default" : "ghost"}
              size="sm"
              onClick={() => setViewMode("grid")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "tree" ? "default" : "ghost"}
              size="sm"
              onClick={() => setViewMode("tree")}
            >
              <TreePine className="h-4 w-4" />
            </Button>
          </div>
          <Link href="/locations/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Location
            </Button>
          </Link>
        </div>
      </div>

      {/* Main Content */}
      {viewMode === "tree" ? (
        <div className="grid h-[600px] grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Location Tree</CardTitle>
              <CardDescription>
                Navigate your location hierarchy
              </CardDescription>
            </CardHeader>
            <CardContent className="h-[500px] p-0">
              <EnhancedLocationTree
                selectedLocationId={selectedLocation?.id}
                onLocationSelect={setSelectedLocation}
              />
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
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
            <CardContent>
              {selectedLocation?.children &&
              selectedLocation.children.length > 0 ? (
                <LocationCardGrid
                  locations={selectedLocation.children}
                  showParentPath={false}
                />
              ) : selectedLocation ? (
                <p className="text-muted-foreground">
                  This location has no child locations.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  Select a location to see its details.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>All Locations</CardTitle>
            <CardDescription>
              Browse your locations in a visual card layout
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LocationCardGrid locations={locations} showParentPath={true} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
