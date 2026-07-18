import { projectKindValues } from "@cubby/schemas/project";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { capitalize } from "./shared";

/**
 * `{value,label}` options for the kind filter/quick-add select — labels
 * derive from `capitalize`, the same title-casing the dashboard's kind badges
 * already use (see `shared.tsx`'s `ProjectTable`/`ProjectCard`), so there's a
 * single source of truth for how a raw kind value renders.
 */
export const projectKindOptions: FilterableComboboxItem[] =
  projectKindValues.map((value) => ({ value, label: capitalize(value) }));
