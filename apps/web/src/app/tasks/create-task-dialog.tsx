import type { ProductId, ProjectId } from "@cubby/schemas/identifiers";
import { unsafeProductId, unsafeProjectId } from "@cubby/schemas/identifiers";
import {
  plainDate,
  type TaskStatus,
  type Trade,
  taskStatusSchema,
  tradeSchema,
} from "@cubby/schemas/project";
import { useMemo } from "react";
import { z } from "zod";
import type { ComboboxItem as ComboboxItemType } from "~/app/_components/combobox/combobox-types";
import { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils/combobox-field-with-search";
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
  subjectProduct: ComboboxItem.nullable(),
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
  presetName?: string;
  presetSubjectProduct?: ComboboxItemType<ProductId> | null;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  presetStatus,
  presetProjectId,
  presetTrade,
  presetDate,
  presetName,
  presetSubjectProduct,
}: CreateTaskDialogProps) {
  const api = useTRPC();
  const { options: projectOptions } = useProjectOptions();

  const defaultValues = useMemo<QuickAddTaskValues>(
    () => ({
      name: presetName ?? "",
      projectId: presetProjectId ?? null,
      status: presetStatus ?? "not_started",
      dueDate: presetDate ?? null,
      trade: presetTrade ?? null,
      subjectProduct: presetSubjectProduct ?? null,
    }),
    [
      presetDate,
      presetName,
      presetProjectId,
      presetStatus,
      presetSubjectProduct,
      presetTrade,
    ],
  );

  return (
    <QuickAddDialog
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddTaskSchema}
      defaultValues={defaultValues}
      title="New Task"
      description="Add a step to work through — optionally attach it to a project or product."
      mutationFn={api.task.create.mutationOptions}
      successMessage={(task) => `Added "${task.name}"`}
      invalidateKeys={taskMutationInvalidateKeys}
      buildPayload={(values) => ({
        name: values.name,
        projectId: values.projectId ? unsafeProjectId(values.projectId) : null,
        status: values.status,
        dueDate: values.dueDate,
        dueEndDate: null,
        subjectProductId: values.subjectProduct?.id
          ? unsafeProductId(values.subjectProduct.id)
          : null,
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
          <ComboboxFieldWithSearch
            form={form}
            name="subjectProduct"
            label="For"
            searchType="product"
          />
          <PlainDateField form={form} name="dueDate" label="Due date" />
        </>
      )}
    </QuickAddDialog>
  );
}
