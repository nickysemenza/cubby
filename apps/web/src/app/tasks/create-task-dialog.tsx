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
// `trade` is required in the domain schema but NOT here — quick capture only
// requires `name`; an omitted trade defaults to "other" in `buildPayload`
// below, matching the domain default used elsewhere (e.g. bulk trade actions).
const quickAddTaskSchema = z.object({
  name: z.string().min(1, "Name is required"),
  projectId: z.string().nullable(),
  status: taskStatusSchema,
  dueDate: plainDate.nullable(),
  trade: tradeSchema.nullable(),
});
type QuickAddTaskValues = z.infer<typeof quickAddTaskSchema>;

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Pre-fill fields from a board quick-add click (status/project/trade axis,
   * a swimlane cell carrying both, or a calendar day). QuickAddDialog
   * re-resolves these defaults whenever it opens.
   */
  presetStatus?: TaskStatus;
  presetProjectId?: ProjectId | null;
  presetTrade?: Trade;
  presetDate?: string;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  presetStatus,
  presetProjectId,
  presetTrade,
  presetDate,
}: CreateTaskDialogProps) {
  const api = useTRPC();
  const { options: projectOptions } = useProjectOptions();

  const defaultValues = useMemo<QuickAddTaskValues>(
    () => ({
      name: "",
      projectId: presetProjectId ?? null,
      status: presetStatus ?? "not_started",
      dueDate: presetDate ?? null,
      trade: presetTrade ?? null,
    }),
    [presetDate, presetProjectId, presetStatus, presetTrade],
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
        // Default when the trade field is left unset — see the schema note.
        trade: values.trade ?? "other",
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
            nullable
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
