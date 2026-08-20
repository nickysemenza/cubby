import type { CalendarItem } from "@cubby/schemas/calendar";
import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
} from "@cubby/schemas/meal-classification";
import { TRADE_LABELS } from "@cubby/schemas/project";
import { EntityCover } from "~/components/entity/entity-cover";
import { Badge } from "~/components/ui/badge";
import { cn, formatCurrency } from "~/lib/utils";
import { mealKindBadgeVariant } from "../meals/meal-options";
import {
  capitalize,
  PROJECT_STATUS_LABELS,
} from "../projects/project-formatting";
import {
  TASK_STATUS_LABELS,
  taskStatusBadgeVariant,
} from "../tasks/task-options";
import { itemIcon } from "./calendar-icons";
import { itemSpanLabel } from "./calendar-span";

type CalendarItemPresentationVariant = "month" | "rich";

function coverImages(item: CalendarItem) {
  return "coverImageUrl" in item && item.coverImageUrl
    ? [{ id: `${item.kind}:${item.id}`, url: item.coverImageUrl }]
    : [];
}

function CalendarItemPresentation({
  item,
  variant,
}: {
  item: CalendarItem;
  variant: CalendarItemPresentationVariant;
}) {
  return variant === "month" ? (
    <CalendarItemCompact item={item} />
  ) : (
    <CalendarItemRich item={item} />
  );
}

function CalendarItemCompact({ item }: { item: CalendarItem }) {
  const Icon = itemIcon(item);
  const span = itemSpanLabel(item);
  return (
    <>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={item.title}>
        {item.title}
      </span>
      {item.kind === "meal" && item.mealKind !== "cooked" && (
        <Badge
          variant={mealKindBadgeVariant[item.mealKind]}
          className="h-4 max-w-24 px-1 text-3xs"
          title={MEAL_KIND_LABELS[item.mealKind]}
        >
          {MEAL_KIND_LABELS[item.mealKind]}
        </Badge>
      )}
      {item.kind === "expense" && (
        <Badge
          variant={item.future ? "warning" : "outline"}
          className="h-4 px-1 text-3xs"
        >
          {item.future ? "Planned" : "Actual"}
        </Badge>
      )}
      {item.kind === "project" && (
        <>
          <Badge variant="outline" className="h-4 px-1 text-3xs">
            {PROJECT_STATUS_LABELS[item.status]}
          </Badge>
          {item.projectKind && (
            <span className="shrink-0 text-muted-foreground">
              {capitalize(item.projectKind)}
            </span>
          )}
        </>
      )}
      {span && (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {span}
        </span>
      )}
      {item.kind === "expense" && item.cost != null && (
        <span className="shrink-0 tabular-nums">
          {formatCurrency(item.cost, 0)}
        </span>
      )}
    </>
  );
}

function CalendarItemRich({ item }: { item: CalendarItem }) {
  const Icon = itemIcon(item);
  const meta = itemMetadata(item);
  const productBacked = item.kind === "expense" || item.kind === "task";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
      <EntityCover
        images={coverImages(item)}
        entity={productBacked ? "product" : item.kind}
        size={36}
        fit={productBacked ? "contain" : "cover"}
        placeholder="none"
        alt=""
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span
            className="min-w-0 flex-1 truncate font-medium"
            title={item.title}
          >
            {item.title}
          </span>
          {item.kind === "expense" && item.cost != null && (
            <span className="shrink-0 font-mono tabular-nums">
              {formatCurrency(item.cost, 0)}
            </span>
          )}
          {item.kind === "meal" && item.cost > 0 && (
            <span className="shrink-0 font-mono tabular-nums">
              {formatCurrency(item.cost, 0)}
            </span>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
          {item.kind === "meal" && item.mealKind !== "cooked" ? (
            <Badge
              variant={mealKindBadgeVariant[item.mealKind]}
              className="h-4 max-w-28 px-1 text-3xs"
            >
              {MEAL_KIND_LABELS[item.mealKind]}
            </Badge>
          ) : item.kind === "task" ? (
            <Badge
              variant={taskStatusBadgeVariant[item.status]}
              className="h-4 max-w-28 px-1 text-3xs"
            >
              {TASK_STATUS_LABELS[item.status]}
            </Badge>
          ) : item.kind === "expense" ? (
            <Badge
              variant={item.future ? "warning" : "outline"}
              className="h-4 px-1 text-3xs"
            >
              {item.future ? "Planned" : "Actual"}
            </Badge>
          ) : null}
          <span className="min-w-0 truncate" title={meta}>
            {meta}
          </span>
          {item.kind === "meal" &&
            (item.calories > 0 || item.nutritionPending) && (
              <span className="ml-auto shrink-0 font-mono tabular-nums">
                {Math.round(item.calories).toLocaleString()}
                {item.nutritionPending ? "+" : ""} cal
              </span>
            )}
        </div>
      </div>
    </div>
  );
}

function itemMetadata(item: CalendarItem): string {
  if (item.kind === "meal") {
    const classification = [
      item.mealType ? MEAL_TYPE_LABELS[item.mealType] : "Unslotted meal",
      item.mealKind === "cooked" ? "Cooked" : null,
    ].filter(Boolean);
    return [...classification, ...item.recipeNames].join(" · ");
  }
  if (item.kind === "task") {
    return [item.projectName, item.subjectProductName, TRADE_LABELS[item.trade]]
      .filter(Boolean)
      .join(" · ");
  }
  if (item.kind === "expense") {
    return [
      item.vendor,
      item.productName,
      item.projectName,
      TRADE_LABELS[item.trade],
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    PROJECT_STATUS_LABELS[item.status],
    item.projectKind ? capitalize(item.projectKind) : null,
    itemSpanLabel(item),
  ]
    .filter(Boolean)
    .join(" · ");
}

const calendarItemTriggerClassName = (item: CalendarItem) =>
  cn(
    "flex min-h-11 w-full items-center gap-2 border-b px-2 py-2 text-left text-sm outline-none last:border-b-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset md:min-h-0",
    item.kind === "expense" && item.future && "text-warning",
  );

export { CalendarItemPresentation, calendarItemTriggerClassName, itemMetadata };
