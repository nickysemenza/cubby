import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityReferencePicker } from "~/app/_components/combobox/entity-reference-picker";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { DialogFormActions } from "~/components/ui/dialog-form-actions";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";

/**
 * The one "pick a destination location" dialog for single-subject moves (the
 * arrange surface's Move to… and the recount session's move). It only chooses
 * and validates a destination; the caller owns the mutation.
 *
 * Mount it only while open: the location search stays off the caller's
 * critical path until the dialog is used. Bulk inventory moves keep
 * `BulkActionDialog` (it previews per-row effects) but share the same picker
 * field via `DestinationLocationField`.
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
        <EntityReferencePicker
          entity="location"
          label="location"
          mapItems={(items) =>
            items.map((item) => {
              const reason = disabledReason(item.id);
              return reason === null
                ? item
                : {
                    ...item,
                    presentation: {
                      ...item.presentation,
                      group: {
                        id: "unavailable",
                        label: "Unavailable",
                        order: 99,
                      },
                      disabledReason: reason,
                    },
                  };
            })
          }
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
