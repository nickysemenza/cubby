import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import {
  plainDate,
  projectKindSchema,
  projectStatusSchema,
} from "@cubby/schemas/project";
import { useMemo } from "react";
import { z } from "zod";
import { QuickAddDialog } from "~/app/_components/forms/quick-add-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { projectMutationInvalidateKeys } from "~/lib/query-keys";
import {
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

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-set `parentProjectId` on the created project — the detail page's
   * "New sub-project" button opens this dialog with the current project. */
  defaultParentProjectId?: ProjectShortcode;
  presetDate?: string;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  defaultParentProjectId,
  presetDate,
}: CreateProjectDialogProps) {
  const api = useTRPC();
  const defaultValues = useMemo<QuickAddProjectValues>(
    () => ({
      name: "",
      status: "planning",
      kind: null,
      costEstimate: null,
      startDate: presetDate ?? null,
    }),
    [presetDate],
  );

  return (
    <QuickAddDialog
      entity="project"
      open={open}
      onOpenChange={onOpenChange}
      schema={quickAddProjectSchema}
      defaultValues={defaultValues}
      title={defaultParentProjectId ? "New Sub-project" : "New Project"}
      description="Start tracking a household undertaking — tasks and expenses attach to it afterward."
      mutationFn={api.project.create.mutationOptions}
      successMessage={(project) => `Added "${project.name}"`}
      invalidateKeys={projectMutationInvalidateKeys}
      buildPayload={(values) => ({
        name: values.name,
        status: values.status,
        kind: values.kind,
        costEstimate: values.costEstimate,
        startDate: values.startDate,
        parentProjectId: defaultParentProjectId ?? null,
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
        </>
      )}
    </QuickAddDialog>
  );
}
