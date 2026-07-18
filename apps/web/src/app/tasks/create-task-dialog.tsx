import { unsafeProjectId } from "@cubby/schemas/identifiers";
import { plainDate, taskStatusSchema } from "@cubby/schemas/project";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { taskMutationInvalidateKeys } from "~/lib/query-keys";
import {
  FormWrapper,
  SelectField,
  UnifiedTextField,
} from "../_components/form-utils";
import { PlainDateField } from "./plain-date-field";
import { taskStatusOptions } from "./task-options";

// projectId stays a plain string here (not the branded `projectId` schema) —
// it's the raw value out of the `SelectField` dropdown; the ProjectId brand is
// applied at the tRPC-call boundary in onSubmit via `unsafeProjectId`. Branding
// it here fights `zodResolver`'s input/output generic (the resolver's Input
// type ends up mismatched against `useForm`'s form-values type).
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

  const form = useForm<QuickAddTaskValues>({
    resolver: zodResolver(quickAddTaskSchema),
    defaultValues,
  });

  const createMutation = useActionMutation({
    mutationFn: api.task.create.mutationOptions,
    success: (task) => `Added "${task.name}"`,
    invalidateKeys: taskMutationInvalidateKeys,
    onSuccess: () => {
      form.reset(defaultValues);
      onOpenChange(false);
    },
  });

  const onSubmit = (values: QuickAddTaskValues) => {
    createMutation.mutate({
      name: values.name,
      projectId: values.projectId ? unsafeProjectId(values.projectId) : null,
      status: values.status,
      dueDate: values.dueDate,
      dueEndDate: null,
      category: null,
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
          <DialogTitle>New Task</DialogTitle>
          <DialogDescription>
            Add a step to work through — optionally attach it to a project.
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
        </FormWrapper>
      </DialogContent>
    </Dialog>
  );
}
