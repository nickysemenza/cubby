import type { CalendarItem, CalendarItemKind } from "@cubby/schemas/calendar";
import type { Entity } from "@cubby/schemas/entity";
import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
} from "@cubby/schemas/meal-classification";
import { TRADE_LABELS } from "@cubby/schemas/project";
import type { LucideIcon } from "lucide-react";
import type { BadgeVariant } from "~/components/ui/badge";
import { ENTITY_ACCENTS } from "~/entities/entity-accents";
import { mealKindBadgeVariant, mealTypeIcon } from "../meals/meal-options";
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

// This is intentionally a UI-layer registry. The shared entity manifest stays
// pure data; calendar layout, badges, and dynamic meal-slot glyphs are React
// presentation concerns. `satisfies` makes a newly-added CalendarItem arm a
// compile-time registry decision rather than an accidental generic card.
type CalendarKindSpec<K extends CalendarItemKind> = {
  entity: Entity;
  icon: (item: ItemOf<K>) => LucideIcon;
  cover: (
    item: ItemOf<K>,
  ) => { entity: Entity; fit: "contain" | "cover"; url: string } | undefined;
  metadata: (item: ItemOf<K>) => string;
  compactBadge?: (item: ItemOf<K>) => CalendarBadge | undefined;
  richBadge?: (item: ItemOf<K>) => CalendarBadge | undefined;
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
    icon: (item) => mealTypeIcon(item.mealType),
    cover: (item) =>
      item.coverImageUrl
        ? { entity: "recipe", fit: "cover", url: item.coverImageUrl }
        : undefined,
    metadata: (item) =>
      [
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
    event: (item) => ({
      className:
        item.mealKind === "cooked"
          ? undefined
          : "border border-dashed border-slate",
      color: ENTITY_ACCENTS.meal,
      priority: 10,
    }),
  },
  task: {
    entity: "task",
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
    event: (item) => ({
      color: ENTITY_ACCENTS.task,
      priority: item.endDateExclusive > item.startDate ? 50 : 10,
    }),
  },
  expense: {
    entity: "expense",
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
            : ENTITY_ACCENTS.expense,
      priority: 10,
    }),
  },
  project: {
    entity: "project",
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
    event: () => ({
      className:
        "bg-muted py-1 hover:bg-muted dark:bg-muted dark:hover:bg-muted",
      color: ENTITY_ACCENTS.project,
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

export { calendarItemPresentation, calendarKindRegistry };
