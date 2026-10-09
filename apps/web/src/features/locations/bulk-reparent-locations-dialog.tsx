import {
  locationShortcode,
  type LocationShortcode,
} from "@cubby/schemas/identifiers";
import type { LocationListItemOut } from "@cubby/schemas/location";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { location } from "~/integrations/tanstack-query/generated/location.gen";
import { referenceEntitySearch } from "~/ui/combobox/reference-entity-search";
import { BulkActionDialog } from "~/ui/dialogs/bulk-action-dialog";
import { requiredLocationCode } from "~/ui/form-fields";
import { EntityValueField } from "~/ui/form-utils/entity-value-field";
import { Stack } from "~/ui/layout";
import { StatusText } from "~/ui/primitives/status-text";

const formSchema = z.object({
  targetParent: requiredLocationCode,
});

const LocationSearch = referenceEntitySearch("location");

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
  // The form stores the parent's shortcode; the effect list shows its name.
  const [targetParentName, setTargetParentName] = useState<string | null>(null);
  const selectedIds = new Set<LocationShortcode>(
    locations.map((location) => location.id),
  );

  const form = useForm<
    z.input<typeof formSchema>,
    unknown,
    z.output<typeof formSchema>
  >({
    resolver: zodResolver(formSchema),
    defaultValues: { targetParent: "" },
  });
  const targetParentId = locationShortcode.safeParse(
    form.watch("targetParent"),
  ).data;

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

  const handleSubmit = form.handleSubmit(async ({ targetParent }) => {
    if (selectedIds.has(targetParent)) {
      setError("Choose a parent that is not one of the selected locations.");
      return;
    }

    setError(null);
    await bulkUpdateParent.mutateAsync({
      ids: [...selectedIds],
      parentId: targetParent,
    });
  });

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
          targetParentId
            ? (location) => ({
                from: location.parent?.name ?? "Home",
                to: targetParentName ?? targetParentId,
                unchanged: location.parent?.id === targetParentId,
                blocked:
                  location.id === targetParentId
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
          <EntityValueField
            form={form}
            name="targetParent"
            label="New Parent Location"
            entity="location"
            SearchProvider={LocationSearch}
            clearable
            onSelect={(item) => setTargetParentName(item?.name ?? null)}
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
