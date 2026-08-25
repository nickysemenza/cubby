import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { LocationListItemOut } from "@cubby/schemas/location";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  getLocationId,
  requiredLocationField,
} from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils/combobox-field-with-search";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Stack } from "~/components/layout";
import { StatusText } from "~/components/ui/status-text";
import { useTRPC } from "~/integrations/trpc/react";
import {
  invalidateQueryRoots,
  invalidatesFor,
  queryKeys,
} from "~/lib/query-keys";

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
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const selectedIds = new Set<LocationShortcode>(
    locations.map((location) => location.id),
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { targetParent: null },
  });

  const bulkUpdateParent = useMutation(
    api.location.bulkUpdateParent.mutationOptions({
      onSuccess: ({ updated }) => {
        invalidateQueryRoots(queryClient, [
          ...invalidatesFor("location"),
          queryKeys.location.all,
        ]);
        toast.success(
          `Moved ${updated} location${updated === 1 ? "" : "s"} to the new parent.`,
        );
        form.reset();
        onSuccess();
        onOpenChange(false);
      },
      onError: (err) => setError(err.message || "Failed to move locations"),
    }),
  );

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
