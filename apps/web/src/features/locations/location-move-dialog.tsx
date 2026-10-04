import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { useState } from "react";

import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { EntityReferencePicker } from "~/ui/combobox/entity-reference-picker";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { DialogFormActions } from "~/ui/primitives/dialog-form-actions";
import { ResponsiveDialog } from "~/ui/primitives/responsive-dialog";

/** A disabled-reason resolver that refuses every location in `sources`. */
export const refuseSourceLocations =
  (sources: readonly LocationShortcode[]) =>
  (locationId: LocationShortcode): string | null =>
    sources.includes(locationId) ? "Already the current location" : null;

/**
 * The one location combobox for move destinations: locations `disabledReason`
 * refuses stay visible in an "Unavailable" group with the reason.
 */
export function LocationDestinationPicker({
  label,
  value,
  setValue,
  disabledReason,
}: {
  label: string;
  value: ComboboxItem<LocationShortcode> | null;
  setValue: (item: ComboboxItem<LocationShortcode> | null) => void;
  disabledReason: (locationId: LocationShortcode) => string | null;
}) {
  return (
    <EntityReferencePicker
      entity="location"
      label={label}
      mapItems={(items) =>
        items.map((item) => {
          const reason = disabledReason(item.id);
          return reason === null
            ? item
            : {
                ...item,
                presentation: {
                  ...item.presentation,
                  group: { id: "unavailable", label: "Unavailable", order: 99 },
                  disabledReason: reason,
                },
              };
        })
      }
      value={value}
      setValue={setValue}
    />
  );
}

/**
 * The one "pick a destination location" dialog for single-subject moves (the
 * arrange surface's Move to…). It only chooses
 * and validates a destination; the caller owns the mutation.
 *
 * Mount it only while open: the location search stays off the caller's
 * critical path until the dialog is used. Bulk inventory moves keep
 * `BulkActionDialog` (it previews per-row effects) but share the same picker
 * via `LocationDestinationPicker`.
 */
export function LocationMoveDialog({
  title,
  description,
  submitLabel,
  onClose,
  disabledReason,
  onConfirm,
  shortcut,
}: {
  title: string;
  description: string;
  submitLabel: string;
  onClose: () => void;
  /** Why `locationId` cannot be the destination, or null when it can. */
  disabledReason: (locationId: LocationShortcode) => string | null;
  /** Resolve with a message to keep the dialog open, or null to close it. */
  onConfirm: (
    destinationId: LocationShortcode,
  ) => Promise<string | null> | string | null;
  /** A one-click destination (e.g. Home) rendered above the picker. It lives
   *  in the body, not the footer: the phone sheet promotes the footer's
   *  Cancel/Move into its header and hides the footer. */
  shortcut?: { label: string; locationId: LocationShortcode | undefined };
}) {
  const [destination, setDestination] =
    useState<ComboboxItem<LocationShortcode> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (destinationId: LocationShortcode) => {
    setPending(true);
    try {
      const refusal = await onConfirm(destinationId);
      if (refusal) setError(refusal);
      else onClose();
    } catch {
      // SILENT: `onConfirm` surfaces its own toast; stay open so the user can
      // pick a different destination and retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      description={description}
      footer={
        <DialogFormActions
          onCancel={onClose}
          submitLabel={submitLabel}
          pending={pending}
          error={error}
          submitDisabled={destination === null}
          onSubmit={() => destination && void submit(destination.id)}
        />
      }
    >
      <Stack gap="md">
        {shortcut && (
          <Button
            variant="outline"
            disabled={!shortcut.locationId || pending}
            onClick={() => {
              if (shortcut.locationId) void submit(shortcut.locationId);
            }}
          >
            {shortcut.label}
          </Button>
        )}
        <LocationDestinationPicker
          label="location"
          disabledReason={disabledReason}
          value={destination}
          setValue={(item) => {
            setDestination(item);
            setError(null);
          }}
        />
      </Stack>
    </ResponsiveDialog>
  );
}
