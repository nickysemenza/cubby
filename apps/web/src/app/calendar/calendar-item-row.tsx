import type { CalendarItem } from "@cubby/schemas/calendar";
import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { mealKindIcon } from "~/app/meals/meal-options";
import { entityDetailLink } from "~/entities/entities";
import { cn, formatCurrency } from "~/lib/utils";
import { itemIcon } from "./calendar-icons";
import { itemSpanLabel } from "./calendar-span";

/**
 * The one-line form of a calendar item, shared by the month view's day drawer
 * and the phone agenda so the two can't render the same record differently.
 */

export function CalendarItemLink({ item }: { item: CalendarItem }) {
  const Icon = itemIcon(item);
  // Only non-cooked meals carry one — the same "surface the exception" rule the
  // month chip and the ICS description follow. Without it the phone agenda,
  // which IS the phone calendar, would be the one surface that can't tell you
  // a night is takeout.
  const kind = item.kind === "meal" ? item.mealKind : null;
  const KindIcon = kind ? mealKindIcon(kind) : null;
  // A span covers every day it touches, so this row repeats across dozens of
  // day sheets — without the range there is nothing to say whether you are
  // looking at its first day or its last.
  const span = itemSpanLabel(item);
  const content: ReactNode = (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={item.title}>
        {item.title}
      </span>
      {span && (
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {span}
        </span>
      )}
      {KindIcon && kind && (
        <KindIcon
          className="size-3.5 shrink-0 text-slate"
          aria-label={MEAL_KIND_LABELS[kind]}
        />
      )}
      {item.kind === "expense" && item.cost != null && (
        <span className="shrink-0 tabular-nums">
          {formatCurrency(item.cost)}
        </span>
      )}
    </>
  );
  // `min-h-11` is the phone touch floor DESIGN.md asks for; desktop keeps the
  // compact row it already had.
  const className = cn(
    "flex min-h-11 items-center gap-2 border-b py-2 text-sm last:border-b-0 hover:text-primary md:min-h-0",
    item.kind === "expense" && item.future && "text-warning",
  );

  if (item.kind === "meal") {
    return (
      <Link {...entityDetailLink("meal", item.id)} className={className}>
        {content}
      </Link>
    );
  }
  if (item.kind === "task") {
    return (
      <Link {...entityDetailLink("task", item.id)} className={className}>
        {content}
      </Link>
    );
  }
  if (item.kind === "expense") {
    return (
      <Link {...entityDetailLink("expense", item.id)} className={className}>
        {content}
      </Link>
    );
  }
  return (
    <Link {...entityDetailLink("project", item.id)} className={className}>
      {content}
    </Link>
  );
}
