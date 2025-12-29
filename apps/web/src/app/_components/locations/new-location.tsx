import { EntityCreateWrapper } from "~/components/entity/entity-create-wrapper";
import type { LocationCreateInput, LocationOut } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { LocationForm } from "./location-form";

export function NewLocation() {
  const api = useTRPC();

  return (
    <EntityCreateWrapper<LocationCreateInput, LocationOut>
      entity="location"
      mutationOptions={api.location.create.mutationOptions()}
    >
      {({ isPending, error, onCreateAsync, onCancel }) => (
        <LocationForm
          mode="create"
          isPending={isPending}
          error={error}
          onCreate={onCreateAsync}
          onCancel={onCancel}
        />
      )}
    </EntityCreateWrapper>
  );
}
