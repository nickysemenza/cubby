import { vendorKindSchema } from "@cubby/schemas/vendor";
import { useMemo } from "react";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { vendorMutationInvalidateKeys } from "~/lib/query-keys";
import {
  NullableTextareaField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { vendorKindOptions } from "./vendor-options";

const quickAddVendorSchema = z.object({
  name: z.string().min(1, "Name is required"),
  kind: vendorKindSchema.nullable(),
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
 * `vendor` column couldn't do. `kind` stays nullable and defaults to blank: the
 * backfill can't infer it, and guessing is worse than empty (see vendor.ts).
 */
export function CreateVendorDialog({
  open,
  onOpenChange,
}: CreateVendorDialogProps) {
  const api = useTRPC();
  const defaultValues = useMemo<QuickAddVendorValues>(
    () => ({ name: "", kind: null, website: null, notes: null }),
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
        kind: values.kind,
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
          <SelectField
            form={form}
            name="kind"
            label="Kind"
            options={vendorKindOptions}
            nullable
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
