import { unsafeProjectId } from "@cubby/schemas/identifiers";
import { plainDate, taskStatusSchema } from "@cubby/schemas/project";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { useTRPC } from "~/integrations/trpc/react";
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import {
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { taskStatusOptions } from "./task-options";

// projectId stays a plain string here (not the branded `projectId` schema) —
// it's the raw value out of the `SelectField` dropdown; the ProjectId brand is
// applied at the tRPC-call boundary in buildPayload via `unsafeProjectId`.
const quickAddTaskSchema = z.object({
  name: z.string().min(1, "Name is required"),
  projectId: z.string().nullable(),
  status: taskStatusSchema,
  dueDate: plainDate.nullable(),
});
type QuickAddTaskValues = z.infer<typeof quickAddTaskSchema>;

const defaultValues: QuickAddTaskValues = {
  name: "",
  projectId: null,
  status: "not_started",
  dueDate: null,
};

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
}: CreateTaskDialogProps) {
  const api = useTRPC();
  const { options: projectOptions } = useProjectOptions();

  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddTaskSchema}
      defaultValues={defaultValues}
      title="New Task"
      description="Add a step to work through — optionally attach it to a project."
      mutationFn={api.task.create.mutationOptions}
      successMessage={(task) => `Added "${task.name}"`}
      invalidateKeys={taskMutationInvalidateKeys}
      buildPayload={(values) => ({
        name: values.name,
        projectId: values.projectId ? unsafeProjectId(values.projectId) : null,
        status: values.status,
        dueDate: values.dueDate,
        dueEndDate: null,
        category: null,
      })}
    >
      {(form) => (
        <>
          <UnifiedTextField
            form={form}
            name="name"
            label="Name"
            placeholder="What needs doing?"
            autoFocus
          />
          <SelectField
            form={form}
            name="status"
            label="Status"
            options={taskStatusOptions}
          />
          <SelectField
            form={form}
            name="projectId"
            label="Project"
            options={projectOptions}
            nullable
          />
          <PlainDateField form={form} name="dueDate" label="Due date" />
        </>
      )}
    </QuickAddDialog>
  );
}
