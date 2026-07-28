import { projectKindValues, projectStatusValues } from "@cubby/schemas/project";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { buildSelectOptions } from "~/lib/select-options";
import { capitalize, PROJECT_STATUS_LABELS } from "./project-formatting";

/**
 * Status select options — the detail page's inline `EditableCell`, the create
 * dialog, and the project table's status filter. Lives here rather than in
 * `shared.tsx` so the filter manifest can import it without closing an import
 * cycle back through that file's tables.
 */
export const PROJECT_STATUS_OPTIONS: FilterableComboboxItem[] =
  buildSelectOptions(projectStatusValues, PROJECT_STATUS_LABELS);

/**
 * `{value,label}` options for the kind filter/quick-add select — labels
 * derive from `capitalize`, the same title-casing the dashboard's kind badges
 * already use (see `shared.tsx`'s `ProjectTable`/`ProjectCard`), so there's a
 * single source of truth for how a raw kind value renders.
 */
export const projectKindOptions: FilterableComboboxItem[] =
  projectKindValues.map((value) => ({ value, label: capitalize(value) }));
