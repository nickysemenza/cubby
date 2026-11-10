import type { CalendarItem } from "@cubby/schemas/calendar";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { capitalize } from "@cubby/shared";
import { cn } from "cn";
import { createContext, useContext } from "react";

import { EntityCover } from "~/entity/components/entity-cover";
import { EntityIdentityMark } from "~/entity/components/entity-identity-mark";
import { useEntityDisplayImage } from "~/entity/entity-media/entity-display-images";
import { InheritedMarker } from "~/entity/fields/field-resolution";
import { formatCurrency } from "~/lib/number-format";
import { estimateStatusText, formatEstimate } from "~/lib/nutrition-format";
import { useHouseholdToday } from "~/lib/use-household-today";
import { FieldRecordValue } from "~/ui/derived/record-value";
import { FieldValueMark } from "~/ui/derived/value-mark";
import { Badge } from "~/ui/reui/badge";

import {
  calendarItemPresentation,
  spendingContextText,
} from "./calendar-kind-registry";
import { itemSpanLabel } from "./calendar-span";

type CalendarItemPresentationVariant = "month" | "detail" | "rich";

function CalendarBeneficiaries({
  item,
  compact = false,
  showInherited = false,
}: {
  item: CalendarItem;
  compact?: boolean;
  showInherited?: boolean;
}) {
  if (item.kind !== "expense" && item.kind !== "purchase") return null;
  // Chips name only recorded beneficiaries; inherited defaults and their
  // markers stay in the inspector.
  const parties = (item.spendingContext?.parties ?? []).filter(
    (party) => showInherited || !party.inherited,
  );
  const sources = item.spendingContext?.beneficiarySources ?? [];
  const envelopes = sources.map(
    (source) => source.fields.effectiveBeneficiaries,
  );
  const status =
    envelopes.find((envelope) => envelope.result.kind === "missing") ??
    envelopes.find(
      (envelope) =>
        envelope.result.kind === "cached" &&
        envelope.result.freshness === "stale",
    );
  if (!parties.length && !status) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center",
        compact
          ? "gap-0.5 [&_[data-slot=inherited-marker]_svg]:size-3"
          : "gap-1",
      )}
    >
      {status ? (
        <FieldValueMark envelope={status} interactive={false}>
          {null}
        </FieldValueMark>
      ) : null}
      {parties.map((party) => (
        <span
          key={party.id}
          className={cn(
            "inline-flex shrink-0 items-center",
            compact ? "gap-0.5" : "gap-1",
          )}
          title={party.name}
        >
          <EntityIdentityMark
            entity="ledgerParty"
            id={party.id}
            name={party.name}
            displayImage={null}
            size={compact ? "compact" : "inline"}
          />
          <span className="sr-only">{party.name}</span>
          {party.inherited && <InheritedMarker />}
        </span>
      ))}
    </span>
  );
}

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
  const image =
    resolvedImage ??
    fieldValueOf(item.source.fields.displayImages)?.[0] ??
    null;
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

/** Whether the calendar shows more than one source, so chips carry their source dot. */
const CalendarMultiSourceContext = createContext(false);

function CalendarItemAmount({
  item,
  className,
}: {
  item: CalendarItem;
  className?: string;
}) {
  if (
    (item.kind !== "expense" && item.kind !== "purchase") ||
    item.cost == null
  )
    return null;
  const refund = item.kind === "purchase" && item.occurrence === "refund";
  return (
    <span
      className={cn(
        "shrink-0 font-mono tabular-nums",
        refund && "text-positive",
        className,
      )}
    >
      {formatCurrency(item.cost)}
    </span>
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
  const multiSource = useContext(CalendarMultiSourceContext);
  const presentation = calendarItemPresentation(item, today);
  const Icon = presentation.icon;
  const span = itemSpanLabel(item, today);
  const context =
    item.kind === "expense" || item.kind === "purchase"
      ? spendingContextText(item)
      : item.kind === "task"
        ? item.assignedProjectName
        : null;
  return (
    <>
      {multiSource && (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-(--ec-event-color)"
        />
      )}
      {image ? (
        <EntityCover images={[image]} entity={item.kind} size={14} alt="" />
      ) : (
        <Icon className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 truncate" title={item.title}>
        {item.title}
      </span>
      {/* Shrinks eight times faster than the title and leaves narrow columns. */}
      {context && (
        <span
          className="min-w-0 shrink-[8] truncate text-muted-foreground @max-[10rem]:hidden"
          title={context}
        >
          {context}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <CalendarBeneficiaries item={item} compact />
        {presentation.compactBadge && (
          <Badge
            variant={presentation.compactBadge.variant}
            className="h-3.5 max-w-24 px-1 text-3xs"
            title={presentation.compactBadge.label}
          >
            {presentation.compactBadge.label}
          </Badge>
        )}
        {item.kind === "project" && fieldValueOf(item.source.fields.kind) && (
          <span className="text-muted-foreground">
            <FieldRecordValue record={item.source} field="kind">
              {capitalize(fieldValueOf(item.source.fields.kind) ?? "")}
            </FieldRecordValue>
          </span>
        )}
        {span && (
          <span className="text-muted-foreground tabular-nums">{span}</span>
        )}
        <CalendarItemAmount item={item} />
      </span>
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
          {!compact && <CalendarItemAmount item={item} />}
          {!compact && item.kind === "meal" && costLabel && (
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
          <CalendarBeneficiaries item={item} />
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

export {
  CalendarItemAmount,
  CalendarItemPresentation,
  CalendarMultiSourceContext,
  calendarItemTriggerClassName,
  itemMetadata,
};
