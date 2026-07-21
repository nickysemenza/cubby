import type { ProjectId } from "@cubby/schemas/identifiers";
import { unsafeProjectId } from "@cubby/schemas/identifiers";
import {
  plainDate,
  type TaskStatus,
  type Trade,
  taskStatusSchema,
  tradeSchema,
} from "@cubby/schemas/project";
import { useMemo } from "react";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { tradeOptions } from "~/app/projects/shared";
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
  // Required in the domain schema — held nullable here so the select can
  // start empty, with the refine forcing a real choice before submit. The
  // `boolean` return annotation stops TS 5.5+ from inferring a narrowing
  // type predicate (QuickAddDialog requires input === output).
  trade: tradeSchema
    .nullable()
    .refine((v): boolean => v !== null, "Trade is required"),
});
type QuickAddTaskValues = z.infer<typeof quickAddTaskSchema>;

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Pre-fill fields from a board quick-add click (status/project/trade axis,
   * or a swimlane cell carrying both). The board hoists one dialog instance
   * and conditionally mounts it per click, so these are only read once, on
   * mount — a fresh mount per preset (see `TaskBoard`'s `pendingPreset`).
   */
  presetStatus?: TaskStatus;
  presetProjectId?: ProjectId | null;
  presetTrade?: Trade;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  presetStatus,
  presetProjectId,
  presetTrade,
}: CreateTaskDialogProps) {
  const api = useTRPC();
  const { options: projectOptions } = useProjectOptions();

  const defaultValues = useMemo<QuickAddTaskValues>(
    () => ({
      name: "",
      projectId: presetProjectId ?? null,
      status: presetStatus ?? "not_started",
      dueDate: null,
      trade: presetTrade ?? null,
    }),
    [presetProjectId, presetStatus, presetTrade],
  );

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
        // Non-null by the schema refine above.
        trade: values.trade!,
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
          <PlainDateField form={form} name="dueDate" label="Due date" />
        </>
      )}
    </QuickAddDialog>
  );
}
