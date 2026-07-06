import type { LocationId } from "@cubby/schemas/identifiers";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import {
  getOptionalLocationId,
  optionalLocationField,
} from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { StatusText } from "~/components/ui/status-text";

const formSchema = z.object({ targetLocation: optionalLocationField });
type FormValues = z.infer<typeof formSchema>;

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
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is being moved, e.g. a product or location name — shown in the title. */
  title: string;
  /** The item's current location; the destination must differ from it. */
  sourceLocationId: LocationId;
  onConfirm: (targetLocationId: LocationId) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { targetLocation: null },
  });

  const close = (next: boolean) => {
    if (!next) {
      form.reset();
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const target = getOptionalLocationId(form.getValues().targetLocation);
    if (!target) {
      setError("Pick a destination location.");
      return;
    }
    if (target === sourceLocationId) {
      setError("Destination must differ from the current location.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onConfirm(target);
      form.reset();
      onOpenChange(false);
    } catch {
      // onConfirm surfaces its own toast; keep the dialog open so the user can
      // pick a different destination and retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {title}</DialogTitle>
          <DialogDescription>
            Pick where this belongs — it moves there now (undo from the toast).
          </DialogDescription>
        </DialogHeader>
        <FormProvider {...form}>
          <Stack gap="md">
            <ComboboxFieldWithSearch
              form={form}
              name="targetLocation"
              label="Destination"
              searchType="location"
            />
            {error && (
              <StatusText as="div" tone="destructive" className="text-sm">
                {error}
              </StatusText>
            )}
          </Stack>
        </FormProvider>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? <Spinner /> : null}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
