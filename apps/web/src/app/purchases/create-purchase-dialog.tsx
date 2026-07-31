import type { VendorShortcode } from "@cubby/schemas/identifiers";
import { unsafeVendorShortcode } from "@cubby/schemas/identifiers";
import { plainDate } from "@cubby/schemas/project";
import { format } from "date-fns";
import { useMemo } from "react";
import { z } from "zod";
import { WithVendorShortcodeSearch } from "~/app/_components/combobox/with-vendor-search";
import { EntityValueField } from "~/app/_components/form-utils/entity-value-field";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseLabel } from "~/lib/purchase-label";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  NullableNumericField,
  PlainDateField,
  UnifiedTextField,
} from "../_components/form-utils";

const today = () => format(new Date(), "yyyy-MM-dd");

// `vendorId` stays a plain string here (not the branded schema) — it's the raw
// value out of the picker, and branding happens exactly once in `buildPayload`,
// at the tRPC-call boundary (see QuickAddDialog's schema constraint).
const quickAddPurchaseSchema = z.object({
  vendorId: z.string().min(1, "Vendor is required"),
  orderId: z.string(),
  date: plainDate.nullable(),
  statedTotal: z.number().nullable(),
  notes: z.string(),
});
type QuickAddPurchaseValues = z.infer<typeof quickAddPurchaseSchema>;

/**
 * New charge — one vendor transaction. Deliberately money-free apart from
 * `statedTotal` (what the paperwork claims): the charge's actual spend is its
 * expense lines, added afterwards, so there's no cost field to fill in here.
 */
export function CreatePurchaseDialog({
  open,
  onOpenChange,
  presetVendorId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill the vendor (e.g. from a vendor's detail page). */
  presetVendorId?: VendorShortcode | null;
}) {
  const api = useTRPC();

  const defaultValues = useMemo<QuickAddPurchaseValues>(
    () => ({
      vendorId: presetVendorId ?? "",
      orderId: "",
      date: today(),
      statedTotal: null,
      notes: "",
    }),
    [presetVendorId],
  );

  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddPurchaseSchema}
      defaultValues={defaultValues}
      title="New Charge"
      description="One vendor transaction — its lines (and every dollar) get added afterwards."
      mutationFn={api.purchase.create.mutationOptions}
      successMessage={(purchase) => `Logged "${purchaseLabel(purchase)}"`}
      invalidateKeys={purchaseMutationInvalidateKeys}
      buildPayload={(values) => ({
        vendorId: unsafeVendorShortcode(values.vendorId),
        orderId: values.orderId.trim() || null,
        date: values.date,
        statedTotal: values.statedTotal,
        notes: values.notes.trim() || null,
      })}
    >
      {(form) => (
        <>
          <EntityValueField<QuickAddPurchaseValues, VendorShortcode>
            form={form}
            name="vendorId"
            entity="vendor"
            label="Vendor"
            placeholder="Who was paid?"
            SearchProvider={WithVendorShortcodeSearch}
          />
          <UnifiedTextField
            form={form}
            name="orderId"
            label="Order #"
            placeholder="Vendor order / receipt #"
          />
          <PlainDateField form={form} name="date" label="Charge date" />
          <NullableNumericField
            form={form}
            name="statedTotal"
            label="Stated total"
            placeholder="What the receipt says"
            step="0.01"
            prefix="$"
          />
          <UnifiedTextField
            form={form}
            name="notes"
            label="Notes"
            placeholder="Anything worth remembering"
          />
        </>
      )}
    </QuickAddDialog>
  );
}
