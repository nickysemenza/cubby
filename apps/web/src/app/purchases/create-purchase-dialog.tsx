import { unsafeProjectId } from "@cubby/schemas/identifiers";
import { plainDate, purchaseCategorySchema } from "@cubby/schemas/project";
import { zodResolver } from "@hookform/resolvers/zod";
import { format } from "date-fns";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  FormWrapper,
  NullableNumericField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { PlainDateField } from "./plain-date-field";
import { purchaseCategoryOptions } from "./purchase-options";

// projectId stays a plain string here (not the branded `projectId` schema) —
// it's the raw value out of the `SelectField` dropdown; the ProjectId brand is
// applied at the tRPC-call boundary in onSubmit via `unsafeProjectId`. Branding
// it here fights `zodResolver`'s input/output generic (the resolver's Input
// type ends up mismatched against `useForm`'s form-values type).
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

  const form = useForm<QuickAddPurchaseValues>({
    resolver: zodResolver(quickAddPurchaseSchema),
    defaultValues: buildDefaultValues(),
  });

  const createMutation = useActionMutation({
    mutationFn: api.purchase.create.mutationOptions,
    success: (purchase) => `Logged "${purchase.name}"`,
    invalidateKeys: purchaseMutationInvalidateKeys,
    onSuccess: () => {
      form.reset(buildDefaultValues());
      onOpenChange(false);
    },
  });

  const onSubmit = (values: QuickAddPurchaseValues) => {
    createMutation.mutate({
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
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset(buildDefaultValues());
        onOpenChange(next);
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>New Purchase</DialogTitle>
          <DialogDescription>
            Log what you bought (or plan to) — the fastest way to keep a
            project's cost honest.
          </DialogDescription>
        </DialogHeader>
        <FormWrapper
          form={form}
          onSubmit={onSubmit}
          isPending={createMutation.isPending}
          error={
            createMutation.error ? createMutation.error.message : undefined
          }
          onCancel={() => onOpenChange(false)}
          submitButtonText="Create"
        >
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
        </FormWrapper>
      </DialogContent>
    </Dialog>
  );
}
