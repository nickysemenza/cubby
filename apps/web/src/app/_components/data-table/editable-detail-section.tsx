import type { ComponentType, ReactNode } from "react";
import type { EditModeProps } from "../form-utils";
import type { UseEditModeReturn } from "../hooks/useEditMode";
import type { DetailSection } from "./detail-page";

/**
 * Build the "Basic Information" detail section every entity detail page hand-wires
 * identically: render the entity's edit form when editing, else the read-only
 * info view. The form prop spread (mode/onEdit/isPending/error/onCancel) lives
 * here once; the read view is passed as `children` so each entity keeps its own
 * info component and extra props (e.g. inventory's onMove/DeleteButton).
 */
export function editableDetailSection<TEditData, TEntity>({
  title,
  icon,
  fullWidth,
  editMode,
  Form,
  entity,
  children,
}: Pick<DetailSection, "title" | "icon" | "fullWidth"> & {
  editMode: UseEditModeReturn<TEditData>;
  Form: ComponentType<EditModeProps<TEditData, TEntity>>;
  entity: TEntity;
  /** The read-mode info view, rendered when not editing. */
  children: ReactNode;
}): DetailSection {
  return {
    title,
    icon,
    fullWidth,
    content: editMode.isEditing ? (
      <Form
        mode="edit"
        entity={entity}
        onEdit={editMode.handleEdit}
        isPending={editMode.isPending}
        error={editMode.error}
        onCancel={editMode.handleCancel}
      />
    ) : (
      children
    ),
  };
}
