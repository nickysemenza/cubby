import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { useState } from "react";
import { FormProvider } from "react-hook-form";

import {
  DestinationLocationField,
  resolveDestination,
  useDestinationLocationForm,
} from "~/app/_components/inventory/destination-location-picker";
import { Button } from "~/components/ui/button";
import { DialogFooter } from "~/components/ui/dialog";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { Spinner } from "~/components/ui/spinner";

/**
 * A session-scoped "move to any location" picker. It only *chooses* a
 * destination and hands the id back via `onConfirm` — the workbench owns the
 * actual `bulkMove` so undo (reverse move + toast) and session invalidation
 * stay in one place, unlike the app-wide MoveInventoryDialog which runs its own
 * mutation without undo.
 */
export function MoveToDialog({
  open,
  onOpenChange,
  title,
  sourceLocationId,
  commit,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is being moved, e.g. a product or location name — shown in the title. */
  title: string;
  /** The item's current location; the destination must differ from it. */
  sourceLocationId: LocationShortcode;
  commit: "done" | "now";
  onConfirm: (targetLocationId: LocationShortcode) => Promise<void>;
}) {
  const { form, error, setError, reset } = useDestinationLocationForm();
  const [pending, setPending] = useState(false);

  const close = (next: boolean) => {
    if (!next) {
      reset();
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const resolved = resolveDestination(
      form.getValues().targetLocation,
      sourceLocationId,
      {
        missingTarget: "Pick a destination location.",
        sameAsSource: "Destination must differ from the current location.",
      },
    );
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onConfirm(resolved.id);
      form.reset();
      onOpenChange(false);
    } catch {
      // SILENT: onConfirm surfaces its own toast; keep the dialog open so the
      // user can pick a different destination and retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={close}
      title={`Move ${title}`}
      description={
        commit === "done"
          ? "Pick where this belongs. The move will be committed with the rest of this recount."
          : "Pick where this belongs — it moves there now (undo from the toast)."
      }
      footer={
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? <Spinner /> : null}
            {commit === "done" ? "Stage move" : "Move"}
          </Button>
        </DialogFooter>
      }
    >
      <FormProvider {...form}>
        <DestinationLocationField
          form={form}
          name="targetLocation"
          label="Destination"
          error={error}
          sourceLocationIds={sourceLocationId}
        />
      </FormProvider>
    </ResponsiveDialog>
  );
}
