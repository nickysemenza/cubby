import type { CalendarItem, CalendarItemKind } from "@cubby/schemas/calendar";
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
  entity: Entity;
  create: (date?: string) => EntityEditDialogRequest;
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

const calendarKindRegistry: {
  [K in CalendarItemKind]: CalendarKindSpec<K>;
} = {
  meal: {
    entity: "meal",
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
    entity: "task",
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
    entity: "expense",
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
        TRADE_LABELS[item.trade],
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
          ? "border border-dashed border-destructive bg-destructive/10 hover:bg-destructive/15 dark:bg-destructive/10 dark:hover:bg-destructive/15"
          : "border border-dashed border-warning bg-warning/10 hover:bg-warning/15 dark:bg-warning/10 dark:hover:bg-warning/15"
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
    entity: "project",
    create: (date) => projectCaptureRequest({ date }),
    icon: () => KIND_ICONS.project,
    cover: () => undefined,
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
    edit: () => ({
      mode: "read-only",
      entity: "project",
      reason:
        "Project dates are derived from its work and spending. Edit the full project to change its record.",
    }),
    event: () => ({
      className:
        "bg-muted py-1 hover:bg-muted dark:bg-muted dark:hover:bg-muted",
      color: entities.project.color.accent,
      priority: 100,
    }),
  },
};

function calendarKindSpec(item: CalendarItem) {
  switch (item.kind) {
    case "meal":
      return calendarKindRegistry.meal;
    case "task":
      return calendarKindRegistry.task;
    case "expense":
      return calendarKindRegistry.expense;
    case "project":
      return calendarKindRegistry.project;
  }
}

function calendarItemPresentation(item: CalendarItem, today = "") {
  const spec = calendarKindSpec(item);
  // The switch above keeps the registry exhaustively typed; callers see one
  // simple presentation value and never need to discriminate CalendarItem.
  return {
    entity: spec.entity,
    icon: spec.icon(item as never),
    cover: spec.cover(item as never),
    metadata: spec.metadata(item as never),
    compactBadge: spec.compactBadge?.(item as never),
    richBadge: spec.richBadge?.(item as never),
    event: spec.event(item as never, today),
  };
}

function calendarItemEditDescriptor(
  item: CalendarItem,
): CalendarEditDescriptor {
  const spec = calendarKindSpec(item);
  return spec.edit(item as never);
}

function calendarItemCreateRequest(kind: CalendarItemKind, date?: string) {
  return calendarKindRegistry[kind].create(date);
}

export {
  calendarItemCreateRequest,
  calendarItemEditDescriptor,
  calendarItemPresentation,
};
