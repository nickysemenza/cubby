"use client";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import type { LocationCreateInput, LocationOut } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { useEntityCreateMode } from "../hooks/useEntityMode";
import { LocationForm } from "./location-form";

export function NewLocation() {
  const api = useTRPC();

  const { error, isPending, handleCreateAsync, handleCancel } =
    useEntityCreateMode<LocationCreateInput, LocationOut>(
      "location",
      api.location.create.mutationOptions(),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New Location</CardTitle>
      </CardHeader>
      <CardContent>
        <LocationForm
          mode="create"
          isPending={isPending}
          error={error}
          onCreate={handleCreateAsync}
          onCancel={handleCancel}
        />
      </CardContent>
    </Card>
  );
}
