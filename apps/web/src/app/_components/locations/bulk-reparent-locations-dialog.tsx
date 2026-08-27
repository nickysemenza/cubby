import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { LocationListItemOut } from "@cubby/schemas/location";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  getLocationId,
  requiredLocationField,
} from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils/combobox-field-with-search";
import { location } from "~/app/locations/location.functions";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Stack } from "~/components/layout";
import { StatusText } from "~/components/ui/status-text";

const formSchema = z.object({
  targetParent: requiredLocationField,
});

type FormValues = z.input<typeof formSchema>;

interface BulkReparentLocationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locations: LocationListItemOut[];
  onSuccess: () => void;
}

export function BulkReparentLocationsDialog({
  open,
  onOpenChange,
  locations,
  onSuccess,
}: BulkReparentLocationsDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const selectedIds = new Set<LocationShortcode>(
    locations.map((location) => location.id),
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { targetParent: null },
  });
  const targetParent = form.watch("targetParent");

  const bulkUpdateParent = useMutation({
    ...location.bulkUpdateParent.mutationOptions(),
    onSuccess: ({ updated }) => {
      toast.success(
        `Moved ${updated} location${updated === 1 ? "" : "s"} to the new parent.`,
      );
      form.reset();
      onSuccess();
      onOpenChange(false);
    },
    onError: (err) => setError(err.message || "Failed to move locations"),
  });

  const handleSubmit = async () => {
    const valid = await form.trigger();
    if (!valid) return;

    const targetParentId = getLocationId(form.getValues("targetParent"));
    if (selectedIds.has(targetParentId)) {
      setError("Choose a parent that is not one of the selected locations.");
      return;
    }

    setError(null);
    await bulkUpdateParent.mutateAsync({
      ids: [...selectedIds],
      parentId: targetParentId,
    });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      form.reset();
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  return (
    <FormProvider {...form}>
      <BulkActionDialog
        open={open}
        onOpenChange={handleOpenChange}
        items={locations}
        action="Move"
        actionLabel="Move locations"
        pendingLabel="Moving..."
        itemNoun="Location"
        description="Select the new parent location for the selected locations."
        renderItem={(location) => location.name}
        // Nothing to project until a parent is chosen. A selected location
        // named as its own new parent is a real blocker, not a no-op: the
        // submit guard below refuses the whole write, so say so up front.
        effect={
          targetParent
            ? (location) => ({
                from: location.parent?.name ?? "Home",
                to: targetParent.name,
                unchanged: location.parent?.id === targetParent.id,
                blocked:
                  location.id === targetParent.id
                    ? "a location cannot be its own parent"
                    : undefined,
              })
            : undefined
        }
        unchangedLabel="already under this parent"
        onSubmit={handleSubmit}
        isPending={bulkUpdateParent.isPending}
      >
        <Stack gap="md">
          <ComboboxFieldWithSearch
            form={form}
            name="targetParent"
            label="New Parent Location"
            searchType="location"
          />

          {error && (
            <StatusText as="div" tone="destructive" className="text-sm">
              {error}
            </StatusText>
          )}
        </Stack>
      </BulkActionDialog>
    </FormProvider>
  );
}
