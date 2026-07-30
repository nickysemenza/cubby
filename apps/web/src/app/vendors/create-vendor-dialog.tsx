import { useMemo } from "react";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { vendorMutationInvalidateKeys } from "~/lib/query-keys";
import {
  NullableTextareaField,
  UnifiedTextField,
} from "../_components/form-utils";

const quickAddVendorSchema = z.object({
  name: z.string().min(1, "Name is required"),
  website: z.string().nullable(),
  notes: z.string().nullable(),
});
type QuickAddVendorValues = z.infer<typeof quickAddVendorSchema>;

interface CreateVendorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Add a vendor before any money has gone there — the one thing the old free-text
 * `vendor` column couldn't do. Identity only: `name` plus two optional fields,
 * mirroring how thin the roster row itself is (see vendor.ts).
 */
export function CreateVendorDialog({
  open,
  onOpenChange,
}: CreateVendorDialogProps) {
  const api = useTRPC();
  const defaultValues = useMemo<QuickAddVendorValues>(
    () => ({ name: "", website: null, notes: null }),
    [],
  );

  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddVendorSchema}
      defaultValues={defaultValues}
      title="New Vendor"
      description="A place money goes. Charges attach to it afterward; all spend lives on their lines."
      mutationFn={api.vendor.create.mutationOptions}
      successMessage={(vendor) => `Added "${vendor.name}"`}
      invalidateKeys={vendorMutationInvalidateKeys}
      buildPayload={(values) => ({
        name: values.name,
        website: values.website,
        notes: values.notes,
      })}
    >
      {(form) => (
        <>
          <UnifiedTextField
            form={form}
            name="name"
            label="Name"
            placeholder="Who are you paying?"
            autoFocus
          />
          <UnifiedTextField
            form={form}
            name="website"
            label="Website"
            placeholder="https://…"
            nullable
          />
          <NullableTextareaField
            form={form}
            name="notes"
            label="Notes"
            placeholder="Account number, rep, delivery quirks…"
          />
        </>
      )}
    </QuickAddDialog>
  );
}
