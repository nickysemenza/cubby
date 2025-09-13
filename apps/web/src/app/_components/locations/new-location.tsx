"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LocationForm } from "./location-form";
import { type LocationCreateInput } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { entities } from "~/entities/entities";

import { useMutation } from "@tanstack/react-query";

export function NewLocation() {
  const api = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const createLocation = useMutation(
    api.location.create.mutationOptions({
      onSuccess: (location) => {
        router.push(`/${entities.location.basePath}/${location.id}`);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleCreate = async (data: LocationCreateInput) => {
    return await createLocation.mutateAsync(data);
  };

  const handleCancel = () => {
    router.push(`/${entities.location.basePath}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New Location</CardTitle>
      </CardHeader>
      <CardContent>
        <LocationForm
          mode="create"
          isPending={createLocation.isPending}
          error={error}
          onCreate={handleCreate}
          onCancel={handleCancel}
        />
      </CardContent>
    </Card>
  );
}
