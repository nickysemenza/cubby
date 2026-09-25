import {
  calendarItemKind,
  type CalendarItemKind,
} from "@cubby/schemas/calendar";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { createElement } from "react";

import { futureFilterOptions } from "~/app/expenses/expense-options";
import { tradeOptions } from "~/app/projects/trade-options";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { fieldEnumOptions } from "~/entities/enum-field-display";
import type { FilterSpec } from "~/entities/filter-manifest";

import { KIND_ICONS } from "./calendar-icons";

/**
 * The calendar's filter manifest.
 *
 * **A standalone spec list, deliberately outside the `entityFilters` registry.**
 * The calendar is not an `Entity`: it has no shortcode prefix, no detail route,
 * no `SearchDocument`, no incoming edges. Registering one to reach the shared
 * bar would force an invented member into ~10 exhaustive `Record<Entity, …>`
 * tables and a fake `calendarFilterFields` entry into three drift guards, all
 * to serve one page. Exporting the specs directly gets `decodeFilters`,
 * `encodeFilters`, and `buildFiltersFromManifest` with none of that — and
 * `calendar-filter-specs.unit.test.ts` re-creates the drift protection the
 * registry would have supplied.
 *
 * A `.ts`, not `.tsx`: the item-kind icons are built with `createElement` so
 * the module stays loadable from the dependency-light `unit` vitest project.
 *
 * **Labels name the kind they scope.** "Task status", not "Status" — a
 * calendar shows four kinds at once, and a bare "Status" chip would read as
 * one that empties the month rather than one that narrows the tasks in it.
 * See `calendarFilterFields` for the cross-kind rule this is the UI half of.
 */

const KIND_LABELS = {
  meal: "Meals",
  task: "Tasks",
  expense: "Expenses",
  project: "Projects",
  planting: "Plantings",
} satisfies Record<CalendarItemKind, string>;

const itemKindOptions: FilterableComboboxItem[] = calendarItemKind.options.map(
  (value) => ({
    value,
    label: KIND_LABELS[value] ?? value,
    icon: createElement(KIND_ICONS[value], { className: "size-3.5" }),
  }),
);

export const calendarFilterSpecs: readonly FilterSpec[] = [
  {
    columnId: "kinds",
    kind: "multiselect",
    label: "Show",
    placeholder: "Filter by item kind...",
    options: itemKindOptions,
  },
  {
    columnId: "project",
    field: "projectId",
    kind: "idMulti",
    // The WIRE takes shortcodes (`oneOrMany(projectShortcode)`), so the brand
    // is the shortcode brand. The entity manifests now declare their identifier
    // kind explicitly, so every filter parser uses the same wire contract.
    brand: (value) => parseShortcodeFor("project", value),
    label: "Project",
    placeholder: "Filter by project...",
    optionsKey: "project",
    nullable: { field: "projectPresenceFilter", label: "project" },
  },
  {
    columnId: "taskStatus",
    kind: "multiselect",
    label: "Task status",
    placeholder: "Filter by task status...",
    options: fieldEnumOptions("task", "status"),
  },
  {
    columnId: "taskTrade",
    kind: "multiselect",
    label: "Task trade",
    placeholder: "Filter by task trade...",
    options: tradeOptions,
  },
  {
    columnId: "vendor",
    field: "expenseVendorId",
    kind: "idMulti",
    brand: (value) => parseShortcodeFor("vendor", value),
    label: "Vendor",
    placeholder: "Filter by vendor...",
    optionsKey: "vendor",
    nullable: { field: "expenseVendorPresenceFilter", label: "vendor" },
  },
  {
    columnId: "future",
    field: "expenseFuture",
    kind: "boolean",
    label: "Expense status",
    placeholder: "Filter by expense status...",
    options: futureFilterOptions,
  },
  {
    columnId: "projectStatus",
    kind: "multiselect",
    label: "Project status",
    placeholder: "Filter by project status...",
    options: fieldEnumOptions("project", "status"),
  },
  {
    // Keeps the pre-existing `?projectKinds=` URL key so old links still
    // resolve. `project.kind`'s own manifest spec claims `?kinds` for the same
    // concept, but that only binds within a route that mounts the project
    // manifest — and /calendar mounts none, where `?kinds` means ITEM kinds.
    columnId: "projectKinds",
    field: "projectKind",
    kind: "multiselect",
    label: "Project kind",
    placeholder: "Filter by project kind...",
    options: fieldEnumOptions("project", "kind"),
    nullable: { field: "projectKindPresenceFilter", label: "kind" },
  },
];

/** Schedule has only Task and Planting lanes. Expense and Project record
 * filters remain in the URL for other calendar modes but are not shown here. */
export const calendarScheduleFilterSpecs: readonly FilterSpec[] = [
  {
    ...calendarFilterSpecs[0]!,
    options: itemKindOptions.filter(
      (option) => option.value === "task" || option.value === "planting",
    ),
  },
  ...calendarFilterSpecs.filter((spec) =>
    ["project", "taskStatus", "taskTrade"].includes(spec.columnId),
  ),
];
