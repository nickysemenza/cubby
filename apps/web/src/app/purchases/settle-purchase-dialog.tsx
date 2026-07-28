import { unsafeProjectId } from "@cubby/schemas/identifiers";
import {
  costTypeSchema,
  type PurchaseOut,
  plainDate,
  tradeSchema,
} from "@cubby/schemas/project";
import { zodResolver } from "@hookform/resolvers/zod";
import { format } from "date-fns";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { tradeOptions } from "~/app/projects/shared";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  FormWrapper,
  NullableNumericField,
  NullableTextareaField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { costTypeOptions } from "./purchase-options";

// projectId stays a plain string here (not the branded `projectId` schema) —
// it's the raw value out of the `SelectField` dropdown; the ProjectId brand is
// applied at the tRPC-call boundary in buildPayload via `unsafeProjectId`,
// same convention as `create-purchase-dialog.tsx`. `cost` is nullable +
// refined (not a plain `z.number()`) so a cleared input reads as `null` (not
// `undefined`) for `NullableNumericField` while still being rejected as
// required — same idiom as the costType/trade refines below and in
// `create-purchase-dialog.tsx`.
const settlePurchaseSchema = z.object({
  cost: z
    .number()
    .nullable()
    .refine((v): boolean => v !== null, "Final cost is required"),
  date: plainDate.nullable(),
  projectId: z.string().nullable(),
  costType: costTypeSchema,
  trade: tradeSchema,
  notes: z.string().nullable(),
  vendor: z.string(),
  orderId: z.string(),
});
type SettlePurchaseValues = z.infer<typeof settlePurchaseSchema>;

interface SettlePurchaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchase: PurchaseOut;
}

/**
 * "Mark purchased" — settles a planned purchase in one write: the final cost,
 * the actual date (defaults to today), and a chance to correct the project /
 * cost type / trade / notes now that the purchase actually happened. Flips
 * `future: false` in the SAME `purchase.update` call, not a separate mutation
 * (see the Planned-view row action in `purchaselist.tsx`).
 */
export function SettlePurchaseDialog({
  open,
  onOpenChange,
  purchase,
}: SettlePurchaseDialogProps) {
  const api = useTRPC();
  const { options: projectOptions } = useProjectOptions();

  const defaultValues = useMemo<SettlePurchaseValues>(
    () => ({
      cost: purchase.cost,
      date: format(new Date(), "yyyy-MM-dd"),
      projectId: purchase.projectId ?? null,
      costType: purchase.costType,
      trade: purchase.trade,
      notes: purchase.notes,
      vendor: purchase.vendor ?? "",
      orderId: purchase.orderId ?? "",
    }),
    [purchase],
  );

  const form = useForm<SettlePurchaseValues>({
    resolver: zodResolver(settlePurchaseSchema),
    defaultValues,
  });

  const updateMutation = useUpdateMutation({
    mutationFn: api.purchase.update.mutationOptions,
    entity: "purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  const onSubmit = (values: SettlePurchaseValues) => {
    updateMutation.mutate(
      {
        id: purchase.id,
        data: {
          // Non-null by the schema refine above — zod has already rejected
          // null before onSubmit runs.
          cost: values.cost!,
          date: values.date,
          projectId: values.projectId
            ? unsafeProjectId(values.projectId)
            : null,
          costType: values.costType,
          trade: values.trade,
          notes: values.notes,
          vendor: values.vendor.trim() || null,
          orderId: values.orderId.trim() || null,
          future: false,
        },
      },
      {
        onSuccess: () => {
          form.reset(defaultValues);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset(defaultValues);
        onOpenChange(next);
      }}
      title={`Mark "${purchase.name}" purchased`}
      description="Log the final cost and date — this moves the purchase off the Planned list."
    >
      <FormWrapper<SettlePurchaseValues>
        form={form}
        onSubmit={onSubmit}
        isPending={updateMutation.isPending}
        error={updateMutation.error ? updateMutation.error.message : undefined}
        onCancel={() => onOpenChange(false)}
        submitButtonText="Mark purchased"
      >
        <NullableNumericField
          form={form}
          name="cost"
          label="Final cost"
          placeholder="e.g. 24.99"
          step="0.01"
          prefix="$"
        />
        <PlainDateField form={form} name="date" label="Purchase date" />
        <SelectField
          form={form}
          name="costType"
          label="Cost Type"
          options={costTypeOptions}
        />
        <SelectField
          form={form}
          name="trade"
          label="Trade"
          options={tradeOptions}
        />
        <SelectField
          form={form}
          name="projectId"
          label="Project"
          options={projectOptions}
          nullable
        />
        <UnifiedTextField
          form={form}
          name="vendor"
          label="Vendor"
          placeholder="Where from?"
        />
        <UnifiedTextField
          form={form}
          name="orderId"
          label="Order #"
          placeholder="Vendor order #"
        />
        <NullableTextareaField
          form={form}
          name="notes"
          label="Notes"
          placeholder="Optional notes"
        />
      </FormWrapper>
    </ResponsiveDialog>
  );
}
