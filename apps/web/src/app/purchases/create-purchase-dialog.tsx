import { unsafeProjectId } from "@cubby/schemas/identifiers";
import { plainDate, purchaseCategorySchema } from "@cubby/schemas/project";
import { format } from "date-fns";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { purchaseCategoryOptions } from "./purchase-options";

// projectId stays a plain string here (not the branded `projectId` schema) —
// it's the raw value out of the `SelectField` dropdown; the ProjectId brand is
// applied at the tRPC-call boundary in buildPayload via `unsafeProjectId`.
const quickAddPurchaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  cost: z.number().nullable(),
  date: plainDate.nullable(),
  projectId: z.string().nullable(),
  category: purchaseCategorySchema.nullable(),
});
type QuickAddPurchaseValues = z.infer<typeof quickAddPurchaseSchema>;

const buildDefaultValues = (): QuickAddPurchaseValues => ({
  name: "",
  cost: null,
  date: format(new Date(), "yyyy-MM-dd"),
  projectId: null,
  category: null,
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
        category: values.category,
        subcategory: null,
        purchaser: null,
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
            name="category"
            label="Category"
            options={purchaseCategoryOptions}
            nullable
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
