import type { TaskShortcode } from "@cubby/schemas/identifiers";
import { plainDate, projectKindSchema } from "@cubby/schemas/project";
import { z } from "zod";
import {
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { projectKindOptions } from "~/app/projects/project-options";
import { useTRPC } from "~/integrations/trpc/react";
import {
  projectMutationInvalidateKeys,
  taskMutationInvalidateKeys,
} from "~/lib/query-keys";

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
 * Inbox toolbar's "Create project from selected" action — a `QuickAddDialog`
 * over `project.createFromTasks` (create + move in one transaction), mirroring
 * `create-project-dialog.tsx`'s field set (name/kind/cost estimate/start date)
 * minus `status` (a promoted-from-inbox project always starts `planning`, the
 * schema default).
 */
export function CreateProjectFromTasksDialog({
  open,
  onOpenChange,
  taskIds,
}: CreateProjectFromTasksDialogProps) {
  const api = useTRPC();
  const count = taskIds.length;

  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddSchema}
      defaultValues={defaultValues}
      title="New Project From Tasks"
      description={`Create a project and move ${count} selected task${count !== 1 ? "s" : ""} onto it.`}
      mutationFn={api.project.createFromTasks.mutationOptions}
      successMessage={(data) => `Created "${data.project.name}"`}
      invalidateKeys={[
        ...taskMutationInvalidateKeys,
        ...projectMutationInvalidateKeys,
      ]}
      buildPayload={(values) => ({
        taskIds,
        project: {
          name: values.name,
          kind: values.kind,
          costEstimate: values.costEstimate,
          startDate: values.startDate,
        },
      })}
    >
      {(form) => (
        <>
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
        </>
      )}
    </QuickAddDialog>
  );
}
