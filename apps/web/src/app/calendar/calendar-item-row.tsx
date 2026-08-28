import type { CalendarItem } from "@cubby/schemas/calendar";

import { EntityCover } from "~/components/entity/entity-cover";
import { Badge } from "~/components/ui/badge";
import { cn, formatCurrency } from "~/lib/utils";

import { calendarItemPresentation } from "./calendar-kind-registry";
import { itemSpanLabel } from "./calendar-span";

type CalendarItemPresentationVariant = "month" | "detail" | "rich";

function CalendarItemPresentation({
  item,
  variant,
}: {
  item: CalendarItem;
  variant: CalendarItemPresentationVariant;
}) {
  if (variant === "month") return <CalendarItemCompact item={item} />;
  // "detail" is the fortnight density: the rich two-line block with a thumbnail
  // shrunk to one line of text, so a 2x7 grid column still fits the title.
  return <CalendarItemRich item={item} compact={variant === "detail"} />;
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

function CalendarItemRich({
  item,
  compact = false,
}: {
  item: CalendarItem;
  /** Fortnight density: a thumbnail one line of body text tall, tighter gap. */
  compact?: boolean;
}) {
  const presentation = calendarItemPresentation(item);
  const Icon = presentation.icon;
  const { cover, metadata } = presentation;
  const cost =
    item.kind === "expense" && item.cost != null
      ? item.cost
      : item.kind === "meal" && item.cost > 0
        ? item.cost
        : null;
  const costLabel = cost == null ? null : formatCurrency(cost, 0);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center",
        compact ? "gap-1" : "gap-2 py-1",
      )}
    >
      {/* Compact keeps its square only when there IS an image; without one the
          leading kind icon on the title line already carries the entity, and a
          placeholder square would eat a quarter of a fortnight column. */}
      <EntityCover
        images={
          cover ? [{ id: `${item.kind}:${item.id}`, url: cover.url }] : []
        }
        entity={cover?.entity ?? presentation.entity}
        size={compact ? 20 : 36}
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
          {/* A fortnight column is ~150px: money on the title line truncates
              the name it is meant to price. Compact sends it down to the data
              line, where the mono numbers already live. */}
          {!compact && costLabel && (
            <span className="shrink-0 font-mono tabular-nums">{costLabel}</span>
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
          <span className="min-w-0 flex-1 truncate" title={metadata}>
            {metadata}
          </span>
          <span className="flex shrink-0 items-center gap-1 font-mono tabular-nums">
            {item.kind === "meal" &&
              (item.calories > 0 || item.nutritionPending) && (
                <span>
                  {Math.round(item.calories).toLocaleString()}
                  {item.nutritionPending ? "+" : ""} cal
                </span>
              )}
            {compact && costLabel && (
              <span className="text-foreground">{costLabel}</span>
            )}
          </span>
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
    item.kind === "expense" && item.future && "text-warning-ink",
  );

export { CalendarItemPresentation, calendarItemTriggerClassName, itemMetadata };
