import { unsafeProjectId } from "@cubby/schemas/identifiers";
import { costTypeSchema, plainDate, tradeSchema } from "@cubby/schemas/project";
import { format } from "date-fns";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { tradeOptions } from "~/app/projects/shared";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { costTypeOptions } from "./purchase-options";

// projectId stays a plain string here (not the branded `projectId` schema) —
// it's the raw value out of the `SelectField` dropdown; the ProjectId brand is
// applied at the tRPC-call boundary in buildPayload via `unsafeProjectId`.
const quickAddPurchaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  cost: z.number().nullable(),
  date: plainDate.nullable(),
  projectId: z.string().nullable(),
  // Required in the domain schema — held nullable here so the select can start
  // empty, with the refine forcing a real choice before submit. The `boolean`
  // return annotations stop TS 5.5+ from inferring a narrowing type predicate,
  // which would change the parsed shape (QuickAddDialog requires input === output).
  costType: costTypeSchema
    .nullable()
    .refine((v): boolean => v !== null, "Cost type is required"),
  trade: tradeSchema
    .nullable()
    .refine((v): boolean => v !== null, "Trade is required"),
});
type QuickAddPurchaseValues = z.infer<typeof quickAddPurchaseSchema>;

const buildDefaultValues = (): QuickAddPurchaseValues => ({
  name: "",
  cost: null,
  date: format(new Date(), "yyyy-MM-dd"),
  projectId: null,
  costType: null,
  trade: null,
});

interface CreatePurchaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreatePurchaseDialog({
  open,
  onOpenChange,
}: CreatePurchaseDialogProps) {
  const api = useTRPC();
  const { options: projectOptions } = useProjectOptions();

  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddPurchaseSchema}
      defaultValues={buildDefaultValues}
      title="New Purchase"
      description="Log what you bought (or plan to) — the fastest way to keep a project's cost honest."
      mutationFn={api.purchase.create.mutationOptions}
      successMessage={(purchase) => `Logged "${purchase.name}"`}
      invalidateKeys={purchaseMutationInvalidateKeys}
      buildPayload={(values) => ({
        name: values.name,
        cost: values.cost,
        date: values.date,
        projectId: values.projectId ? unsafeProjectId(values.projectId) : null,
        // Non-null by the schema refines above — zod has already rejected
        // null before buildPayload runs.
        costType: values.costType!,
        trade: values.trade!,
        url: null,
        notes: null,
        future: false,
      })}
    >
      {(form) => (
        <>
          <UnifiedTextField
            form={form}
            name="name"
            label="Name"
            placeholder="What did you buy?"
            autoFocus
          />
          <NullableNumericField
            form={form}
            name="cost"
            label="Cost"
            placeholder="e.g. 24.99"
            step="0.01"
            prefix="$"
          />
          <PlainDateField form={form} name="date" label="Date" />
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
        </>
      )}
    </QuickAddDialog>
  );
}
