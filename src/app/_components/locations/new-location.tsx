"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LocationForm, type CreateLocationData } from "./location-form";
import { useTRPC } from "~/trpc/react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

import { useMutation } from "@tanstack/react-query";

export function NewLocation() {
  const api = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const createLocation = useMutation(
    api.location.create.mutationOptions({
      onSuccess: (location) => {
        router.push(`/locations/${location.id}`);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleCreate = (data: CreateLocationData) => {
    createLocation.mutate(data);
  };

  const handleCancel = () => {
    router.push("/locations");
  };

  return (
    <div className="container mx-auto py-10">
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
    </div>
  );
}
