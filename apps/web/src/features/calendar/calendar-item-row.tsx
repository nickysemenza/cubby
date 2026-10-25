import type { CalendarItem } from "@cubby/schemas/calendar";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { capitalize } from "@cubby/shared";

import { EntityCover } from "~/entity/components/entity-cover";
import { useEntityDisplayImage } from "~/entity/entity-media/entity-display-images";
import { formatCurrency } from "~/lib/number-format";
import { estimateStatusText, formatEstimate } from "~/lib/nutrition-format";
import { cn } from "~/lib/utils";
import { useHouseholdToday } from "~/ui/hooks/use-household-today";
import { Badge } from "~/ui/primitives/badge";

import { calendarItemPresentation } from "./calendar-kind-registry";
import { itemSpanLabel } from "./calendar-span";

type CalendarItemPresentationVariant = "month" | "detail" | "rich";

function calendarItemCost(item: CalendarItem) {
  if (
    (item.kind === "expense" || item.kind === "purchase") &&
    item.cost != null
  )
    return formatCurrency(item.cost);
  if (
    item.kind === "meal" &&
    !(
      item.mealTotals.cost.status === "unavailable" &&
      item.mealTotals.cost.reason === "empty"
    )
  )
    return formatEstimate(item.mealTotals.cost, "cost");
  return null;
}

function MealCalories({ item }: { item: CalendarItem }) {
  if (item.kind !== "meal") return null;
  const kcal = item.mealTotals.nutrition.kcal;
  if (kcal.status === "unavailable" && kcal.reason === "empty") return null;
  return (
    <span title={estimateStatusText(kcal) ?? undefined}>
      {formatEstimate(kcal, "kcal", "kcal")}
    </span>
  );
}

function CalendarItemPresentation({
  item,
  variant,
}: {
  item: CalendarItem;
  variant: CalendarItemPresentationVariant;
}) {
  const resolvedImage = useEntityDisplayImage({
    entityKind: item.kind,
    entityId: item.id,
  });
  const image = resolvedImage ?? item.displayImages[0] ?? null;
  if (variant === "month")
    return <CalendarItemCompact item={item} image={image} />;
  // "detail" is the fortnight density: the rich two-line block with a thumbnail
  // shrunk to one line of text, so a 2x7 grid column still fits the title.
  return (
    <CalendarItemRich
      item={item}
      image={image}
      compact={variant === "detail"}
    />
  );
}

function CalendarItemCompact({
  item,
  image,
}: {
  item: CalendarItem;
  image: ImageUrlSummary | null;
}) {
  const today = useHouseholdToday();
  const presentation = calendarItemPresentation(item, today);
  const Icon = presentation.icon;
  const span = itemSpanLabel(item, today);
  const context = [
    {
      kind: "project",
      label:
        item.kind === "task"
          ? item.assignedProjectName
          : item.kind === "expense" || item.kind === "purchase"
            ? item.spendingContext?.projectNames.join(", ")
            : null,
    },
    {
      kind: "party",
      label:
        item.kind === "expense" || item.kind === "purchase"
          ? item.spendingContext?.partyNames.join(", ")
          : null,
    },
  ].filter(({ label }) => Boolean(label));
  return (
    <>
      {image ? (
        <EntityCover images={[image]} entity={item.kind} size={18} alt="" />
      ) : (
        <Icon className="size-3 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate" title={item.title}>
        {item.title}
      </span>
      {context.length > 0 && (
        <span
          className={cn(
            "flex min-w-0 gap-1 text-muted-foreground",
            context.length > 1 ? "flex-[2]" : "flex-1",
          )}
        >
          {context.map(({ kind, label }) => (
            <span
              key={kind}
              className="min-w-0 flex-1 truncate"
              title={label ?? undefined}
            >
              {label}
            </span>
          ))}
        </span>
      )}
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
          {capitalize(item.projectKind)}
        </span>
      )}
      {span && (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {span}
        </span>
      )}
      {(item.kind === "expense" || item.kind === "purchase") &&
        item.cost != null && (
          <span className="shrink-0 tabular-nums">
            {formatCurrency(item.cost)}
          </span>
        )}
    </>
  );
}

function CalendarItemRich({
  item,
  image,
  compact = false,
}: {
  item: CalendarItem;
  image: ImageUrlSummary | null;
  /** Fortnight density: a thumbnail one line of body text tall, tighter gap. */
  compact?: boolean;
}) {
  const today = useHouseholdToday();
  const presentation = calendarItemPresentation(item, today);
  const Icon = presentation.icon;
  const { metadata } = presentation;
  const cost = calendarItemCost(item);
  const costLabel = cost;
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
        images={image ? [image] : []}
        entity={presentation.entity}
        fit="contain"
        size={compact ? 20 : 36}
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
            <MealCalories item={item} />
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
