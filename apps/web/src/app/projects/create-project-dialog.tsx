import {
  plainDate,
  projectKindSchema,
  projectStatusSchema,
} from "@cubby/schemas/project";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { projectMutationInvalidateKeys } from "~/lib/query-keys";
import {
  FormWrapper,
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { projectKindOptions } from "./project-options";
import { PROJECT_STATUS_OPTIONS } from "./shared";

const quickAddProjectSchema = z.object({
  name: z.string().min(1, "Name is required"),
  status: projectStatusSchema,
  kind: projectKindSchema.nullable(),
  costEstimate: z.number().nullable(),
  startDate: plainDate.nullable(),
});
type QuickAddProjectValues = z.infer<typeof quickAddProjectSchema>;

const defaultValues: QuickAddProjectValues = {
  name: "",
  status: "planning",
  kind: null,
  costEstimate: null,
  startDate: null,
};

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
}: CreateProjectDialogProps) {
  const api = useTRPC();

  const form = useForm<QuickAddProjectValues>({
    resolver: zodResolver(quickAddProjectSchema),
    defaultValues,
  });

  const createMutation = useActionMutation({
    mutationFn: api.project.create.mutationOptions,
    success: (project) => `Added "${project.name}"`,
    invalidateKeys: projectMutationInvalidateKeys,
    onSuccess: () => {
      form.reset(defaultValues);
      onOpenChange(false);
    },
  });

  const onSubmit = (values: QuickAddProjectValues) => {
    createMutation.mutate({
      name: values.name,
      status: values.status,
      kind: values.kind,
      costEstimate: values.costEstimate,
      startDate: values.startDate,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset(defaultValues);
        onOpenChange(next);
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Start tracking a household undertaking — tasks and purchases attach
            to it afterward.
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
            placeholder="What are you working on?"
            autoFocus
          />
          <SelectField
            form={form}
            name="status"
            label="Status"
            options={PROJECT_STATUS_OPTIONS}
          />
          <SelectField
            form={form}
            name="kind"
            label="Kind"
            options={projectKindOptions}
            nullable
          />
          <NullableNumericField
            form={form}
            name="costEstimate"
            label="Cost estimate"
            placeholder="e.g. 500"
            step="0.01"
            prefix="$"
          />
          <PlainDateField form={form} name="startDate" label="Start date" />
        </FormWrapper>
      </DialogContent>
    </Dialog>
  );
}
