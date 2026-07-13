import type { LocationCreateInput, LocationOut } from "@cubby/schemas/location";
import type { FC } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { LocationForm } from "./location-form";

interface CreateChildLocationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentLocation: LocationOut;
  onSuccess: (newLocation: LocationOut) => void;
}

export const CreateChildLocationDialog: FC<CreateChildLocationDialogProps> = ({
  open,
  onOpenChange,
  parentLocation,
  onSuccess,
}) => {
  const api = useTRPC();

  const createMutation = useActionMutation({
    mutationFn: api.location.create.mutationOptions,
    success: (newLocation) =>
      savedWithBackgroundWork(
        newLocation.sideEffects,
        `Created "${newLocation.name}"`,
      ),
    onSuccess: (newLocation) => {
      onOpenChange(false);
      onSuccess(newLocation);
    },
  });

  const handleCreate = async (data: LocationCreateInput) => {
    return createMutation.mutateAsync(data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Create Child Location</DialogTitle>
          <DialogDescription>
            Create a new location inside "{parentLocation.name}"
          </DialogDescription>
        </DialogHeader>
        <LocationForm
          mode="create"
          onCreate={handleCreate}
          isPending={createMutation.isPending}
          error={
            createMutation.error
              ? getErrorMessage(createMutation.error)
              : undefined
          }
          onCancel={() => onOpenChange(false)}
          initialParent={parentLocation}
        />
      </DialogContent>
    </Dialog>
  );
};
