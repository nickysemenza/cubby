import type { TaskShortcode } from "@cubby/schemas/identifiers";
import { plainDate, projectKindSchema } from "@cubby/schemas/project";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  FormWrapper,
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { projectKindOptions } from "~/app/projects/project-options";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidatesFor } from "~/lib/query-keys";

const quickAddSchema = z.object({
  name: z.string().min(1, "Name is required"),
  kind: projectKindSchema.nullable(),
  costEstimate: z.number().nullable(),
  startDate: plainDate.nullable(),
});
type QuickAddValues = z.infer<typeof quickAddSchema>;

const defaultValues: QuickAddValues = {
  name: "",
  kind: null,
  costEstimate: null,
  startDate: null,
};

interface CreateProjectFromTasksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected Inbox tasks to move onto the new project once it's created. */
  taskIds: TaskShortcode[];
}

/**
 * Inbox toolbar's "Create project from selected" action. This remains a
 * specialized workflow because create + move is one server transaction, not
 * an ordinary Project CRUD intent.
 */
export function CreateProjectFromTasksDialog({
  open,
  onOpenChange,
  taskIds,
}: CreateProjectFromTasksDialogProps) {
  const api = useTRPC();
  const count = taskIds.length;
  const form = useForm<QuickAddValues>({
    resolver: zodResolver(quickAddSchema),
    defaultValues,
  });
  const mutation = useActionMutation({
    mutationFn: api.project.createFromTasks.mutationOptions,
    invalidateKeys: [...invalidatesFor("task"), ...invalidatesFor("project")],
    success: (data) => `Created "${data.project.name}"`,
    onSuccess: () => onOpenChange(false),
  });

  useEffect(() => {
    if (open) form.reset(defaultValues);
  }, [form, open]);

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New Project From Tasks"
      description={`Create a project and move ${count} selected task${count !== 1 ? "s" : ""} onto it.`}
    >
      <FormWrapper
        form={form}
        onSubmit={(values) =>
          mutation.mutate({
            taskIds,
            project: {
              name: values.name,
              kind: values.kind,
              costEstimate: values.costEstimate,
              startDate: values.startDate,
            },
          })
        }
        isPending={mutation.isPending}
        error={mutation.error ? getErrorMessage(mutation.error) : undefined}
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
    </ResponsiveDialog>
  );
}
