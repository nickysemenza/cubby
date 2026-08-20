import type { CalendarItem } from "@cubby/schemas/calendar";
import { EntityCover } from "~/components/entity/entity-cover";
import { Badge } from "~/components/ui/badge";
import { cn, formatCurrency } from "~/lib/utils";
import { calendarItemPresentation } from "./calendar-kind-registry";
import { itemSpanLabel } from "./calendar-span";

type CalendarItemPresentationVariant = "month" | "rich";

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
  const presentation = calendarItemPresentation(item);
  const Icon = presentation.icon;
  const span = itemSpanLabel(item);
  return (
    <>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={item.title}>
        {item.title}
      </span>
      {presentation.compactBadge && (
        <Badge
          variant={presentation.compactBadge.variant}
          className="h-4 max-w-24 px-1 text-3xs"
          title={presentation.compactBadge.label}
        >
          {presentation.compactBadge.label}
        </Badge>
      )}
      {item.kind === "project" && item.projectKind && (
        <span className="shrink-0 text-muted-foreground">
          {item.projectKind[0]?.toUpperCase() + item.projectKind.slice(1)}
        </span>
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
  const presentation = calendarItemPresentation(item);
  const Icon = presentation.icon;
  const { cover, metadata } = presentation;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 py-1">
      <EntityCover
        images={
          cover ? [{ id: `${item.kind}:${item.id}`, url: cover.url }] : []
        }
        entity={cover?.entity ?? presentation.entity}
        size={36}
        fit={cover?.fit}
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
          {presentation.richBadge && (
            <Badge
              variant={presentation.richBadge.variant}
              className="h-4 max-w-28 px-1 text-3xs"
            >
              {presentation.richBadge.label}
            </Badge>
          )}
          <span className="min-w-0 truncate" title={metadata}>
            {metadata}
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

const itemMetadata = (item: CalendarItem): string =>
  calendarItemPresentation(item).metadata;

const calendarItemTriggerClassName = (item: CalendarItem) =>
  cn(
    "flex min-h-11 w-full items-center gap-2 border-b px-2 py-2 text-left text-sm outline-none last:border-b-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset md:min-h-0",
    item.kind === "expense" && item.future && "text-warning",
  );

export { CalendarItemPresentation, calendarItemTriggerClassName, itemMetadata };
