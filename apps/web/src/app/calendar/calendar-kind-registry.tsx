import {
  CALENDAR_PLANTING_MILESTONE_LABELS,
  type CalendarItem,
  type CalendarItemKind,
} from "@cubby/schemas/calendar";
import type { Entity } from "@cubby/schemas/entity";
import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
} from "@cubby/schemas/meal-classification";
import { TRADE_LABELS } from "@cubby/schemas/project";
import type { LucideIcon } from "lucide-react";

import type { BadgeVariant } from "~/components/ui/badge";
import {
  expenseCaptureRequest,
  mealCaptureRequest,
  projectCaptureRequest,
  taskCaptureRequest,
} from "~/entities/editing/editor-requests";
import type { EntityEditDialogRequest } from "~/entities/editing/entity-edit-dialog";
import type { EntityEditIntent } from "~/entities/editing/intent-types";
import type {
  EditableEntity,
  EntityEditRecord,
} from "~/entities/editing/types";
import { entities } from "~/entities/entities";

import {
  mealKindBadgeVariant,
  mealTypeIcon,
  mealTypeTimeLabel,
} from "../meals/meal-options";
import {
  capitalize,
  PROJECT_STATUS_LABELS,
} from "../projects/project-formatting";
import {
  TASK_STATUS_LABELS,
  taskStatusBadgeVariant,
} from "../tasks/task-options";
import { KIND_ICONS } from "./calendar-icons";
import { itemSpanLabel } from "./calendar-span";

type ItemOf<K extends CalendarItemKind> = Extract<CalendarItem, { kind: K }>;
type CalendarBadge = {
  label: string;
  variant: BadgeVariant;
};
type CalendarEditDescriptor =
  | {
      mode: "editable";
      entity: EditableEntity;
      intent: EntityEditIntent<"meal" | "task" | "expense", "update">;
      record: EntityEditRecord;
    }
  | {
      mode: "read-only";
      entity: EditableEntity;
      reason: string;
    };

// This is intentionally a UI-layer registry. The shared entity manifest stays
// pure data; calendar layout, badges, and dynamic meal-slot glyphs are React
// presentation concerns. `satisfies` makes a newly-added CalendarItem arm a
// compile-time registry decision rather than an accidental generic card.
type CalendarKindSpec<K extends CalendarItemKind> = {
  // No `entity` field: every calendar kind IS the entity it shows, and
  // `item.kind` already carries it to the one place that asked. Restating it
  // per entry only created a way for `meal` to claim it was a task.
  //
  // Optional: a kind with no calendar-originated creation flow (`planting`,
  // whose records only ever start from the generic plantings pages, not the
  // calendar) omits it entirely rather than supplying a throwing stub.
  // `ALL_KINDS` in unified-calendar.tsx is the day-sheet's own creatable-kind
  // list and never includes such a kind, so `calendarItemCreateRequest` is
  // never called with one in practice.
  create?: (date?: string) => EntityEditDialogRequest;
  icon: (item: ItemOf<K>) => LucideIcon;
  cover: (
    item: ItemOf<K>,
  ) => { entity: Entity; fit: "contain" | "cover"; url: string } | undefined;
  metadata: (item: ItemOf<K>) => string;
  compactBadge?: (item: ItemOf<K>) => CalendarBadge | undefined;
  richBadge?: (item: ItemOf<K>) => CalendarBadge | undefined;
  edit: (item: ItemOf<K>) => CalendarEditDescriptor;
  event: (
    item: ItemOf<K>,
    today: string,
  ) => {
    className?: string;
    color: string;
    priority: number;
  };
};

const calendarKindRegistry = {
  meal: {
    create: (date) => mealCaptureRequest({ date }),
    icon: (item) => mealTypeIcon(item.mealType),
    cover: (item) =>
      item.coverImageUrl
        ? { entity: "recipe", fit: "cover", url: item.coverImageUrl }
        : undefined,
    // Time first, the way an agenda reads. It is the slot's canonical hour, not
    // a stored one — the same map the ICS feed places the event at, so a chip
    // here and the event in a subscribed calendar always agree.
    metadata: (item) =>
      [
        mealTypeTimeLabel(item.mealType),
        item.mealType ? MEAL_TYPE_LABELS[item.mealType] : "Unslotted meal",
        item.mealKind === "cooked" ? "Cooked" : null,
        ...item.recipeNames,
      ]
        .filter(Boolean)
        .join(" · "),
    compactBadge: (item) =>
      item.mealKind === "cooked"
        ? undefined
        : {
            label: MEAL_KIND_LABELS[item.mealKind],
            variant: mealKindBadgeVariant[item.mealKind],
          },
    richBadge: (item) =>
      item.mealKind === "cooked"
        ? undefined
        : {
            label: MEAL_KIND_LABELS[item.mealKind],
            variant: mealKindBadgeVariant[item.mealKind],
          },
    edit: (item) => ({
      mode: "editable",
      entity: "meal",
      intent: "calendar",
      record: {
        id: item.id,
        name: item.name,
        date: item.startDate,
        mealType: item.mealType,
        mealKind: item.mealKind,
      },
    }),
    event: (item) => ({
      className:
        item.mealKind === "cooked"
          ? undefined
          : "border border-dashed border-slate",
      color: entities.meal.color.accent,
      priority: 10,
    }),
  },
  task: {
    create: (date) => taskCaptureRequest({ date }),
    icon: () => KIND_ICONS.task,
    cover: (item) =>
      item.coverImageUrl
        ? { entity: "product", fit: "contain", url: item.coverImageUrl }
        : undefined,
    metadata: (item) =>
      [item.projectName, item.subjectProductName, TRADE_LABELS[item.trade]]
        .filter(Boolean)
        .join(" · "),
    richBadge: (item) => ({
      label: TASK_STATUS_LABELS[item.status],
      variant: taskStatusBadgeVariant[item.status],
    }),
    edit: (item) => ({
      mode: "editable",
      entity: "task",
      intent: "schedule",
      record: {
        id: item.id,
        name: item.title,
        status: item.status,
        dueDate: item.dueDate ?? item.dueEndDate,
        dueEndDate: item.dueDate ? item.dueEndDate : null,
      },
    }),
    event: (item) => ({
      color: entities.task.color.accent,
      priority: item.endDateExclusive > item.startDate ? 50 : 10,
    }),
  },
  expense: {
    create: (date) => expenseCaptureRequest({ date, future: true }),
    icon: () => KIND_ICONS.expense,
    cover: (item) =>
      item.coverImageUrl
        ? { entity: "product", fit: "contain", url: item.coverImageUrl }
        : undefined,
    metadata: (item) =>
      [
        item.vendor,
        item.productName,
        item.projectName,
        item.trade ? TRADE_LABELS[item.trade] : "Unassigned trade",
      ]
        .filter(Boolean)
        .join(" · "),
    compactBadge: (item) => ({
      label: item.future ? "Planned" : "Actual",
      variant: item.future ? "warning" : "outline",
    }),
    richBadge: (item) => ({
      label: item.future ? "Planned" : "Actual",
      variant: item.future ? "warning" : "outline",
    }),
    edit: (item) =>
      item.future
        ? {
            mode: "editable",
            entity: "expense",
            intent: "planned",
            record: {
              id: item.id,
              name: item.title,
              date: item.startDate,
              cost: item.cost,
              future: true,
            },
          }
        : {
            mode: "read-only",
            entity: "expense",
            reason:
              "Recorded expenses stay read-only in the calendar. Open the full expense to make ledger changes.",
          },
    event: (item, today) => ({
      className: item.future
        ? item.startDate < today
          ? "border border-dashed border-destructive bg-destructive/10 hover:bg-destructive/15"
          : "border border-dashed border-warning bg-warning/10 hover:bg-warning/15"
        : undefined,
      color:
        item.future && item.startDate < today
          ? "var(--destructive)"
          : item.future
            ? "var(--warning)"
            : entities.expense.color.accent,
      priority: 10,
    }),
  },
  project: {
    create: (date) => projectCaptureRequest({ date }),
    icon: (_item) => KIND_ICONS.project,
    cover: (_item) => undefined,
    metadata: (item) =>
      [
        PROJECT_STATUS_LABELS[item.status],
        item.projectKind ? capitalize(item.projectKind) : null,
        itemSpanLabel(item),
      ]
        .filter(Boolean)
        .join(" · "),
    compactBadge: (item) => ({
      label: PROJECT_STATUS_LABELS[item.status],
      variant: "outline",
    }),
    edit: (_item) => ({
      mode: "read-only",
      entity: "project",
      reason:
        "Project dates are derived from its work and spending. Edit the full project to change its record.",
    }),
    event: (_item, _today) => ({
      className: "bg-muted py-1 hover:bg-muted",
      color: entities.project.color.accent,
      priority: 100,
    }),
  },
  planting: {
    // No `create`: a planting only ever starts from the Garden surface — see
    // the optional-field note on `CalendarKindSpec.create`.
    icon: () => KIND_ICONS.planting,
    cover: () => undefined,
    metadata: (item) =>
      [
        CALENDAR_PLANTING_MILESTONE_LABELS[item.milestone],
        item.plannedWindow,
        item.locationName,
      ]
        .filter(Boolean)
        .join(" · "),
    edit: (_item) => ({
      mode: "read-only",
      entity: "planting",
      reason: "Planting dates are edited from the planting.",
    }),
    event: (_item, _today) => ({
      color: entities.planting.color.accent,
      priority: 10,
    }),
  },
} satisfies {
  [K in CalendarItemKind]: CalendarKindSpec<K>;
};

function calendarItemPresentationFor<K extends CalendarItemKind>(
  item: ItemOf<K>,
  spec: CalendarKindSpec<K>,
  today: string,
) {
  return {
    // The kind and the entity are the same thing here — see CalendarKindSpec.
    entity: item.kind,
    icon: spec.icon(item),
    cover: spec.cover(item),
    metadata: spec.metadata(item),
    compactBadge: spec.compactBadge?.(item),
    richBadge: spec.richBadge?.(item),
    event: spec.event(item, today),
  };
}

function calendarItemPresentation(item: CalendarItem, today = "") {
  switch (item.kind) {
    case "meal":
      return calendarItemPresentationFor(
        item,
        calendarKindRegistry.meal,
        today,
      );
    case "task":
      return calendarItemPresentationFor(
        item,
        calendarKindRegistry.task,
        today,
      );
    case "expense":
      return calendarItemPresentationFor(
        item,
        calendarKindRegistry.expense,
        today,
      );
    case "project":
      return calendarItemPresentationFor(
        item,
        calendarKindRegistry.project,
        today,
      );
    case "planting":
      return calendarItemPresentationFor(
        item,
        calendarKindRegistry.planting,
        today,
      );
  }
}

function calendarItemEditDescriptor(
  item: CalendarItem,
): CalendarEditDescriptor {
  switch (item.kind) {
    case "meal":
      return calendarKindRegistry.meal.edit(item);
    case "task":
      return calendarKindRegistry.task.edit(item);
    case "expense":
      return calendarKindRegistry.expense.edit(item);
    case "project":
      return calendarKindRegistry.project.edit(item);
    case "planting":
      return calendarKindRegistry.planting.edit(item);
  }
}

function calendarItemCreateRequest(kind: CalendarItemKind, date?: string) {
  // SAFETY: indexing the registry by a union key yields a union of specs
  // whose `item` parameters are incompatible; only the `create` member is
  // needed, and every member's `create` is optional with this same shape.
  const { create } = calendarKindRegistry[kind] as {
    create?: (date?: string) => EntityEditDialogRequest;
  };
  if (!create) {
    // Callers only ever pass a kind from a creatable-kind list (e.g.
    // `ALL_KINDS` in unified-calendar.tsx) — reaching here is a caller bug,
    // not a state a user action can trigger.
    throw new Error(`Calendar kind "${kind}" has no creation flow.`);
  }
  return create(date);
}

export {
  calendarItemCreateRequest,
  calendarItemEditDescriptor,
  calendarItemPresentation,
};
