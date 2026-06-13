import type { LocationCreateInput, LocationOut } from "@cubby/schemas/location";
import { useMutation } from "@tanstack/react-query";
import type { FC } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPC } from "~/trpc/react";
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

  const createMutation = useMutation(
    api.location.create.mutationOptions({
      onSuccess: (newLocation) => {
        toast.success(`Created "${newLocation.name}"`);
        onOpenChange(false);
        onSuccess(newLocation);
      },
      onError: (error) => {
        toast.error(getErrorMessage(error));
      },
    }),
  );

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
