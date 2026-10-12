import { formatDateSpan, stackedDateSpan } from "~/lib/date-span";
import { StackedValue, useDenseCell } from "~/ui/common/stacked-value";
import { useHouseholdToday } from "~/ui/hooks/use-household-today";

/**
 * A plain-date span. `stacked` is the table-cell form: the date over a muted
 * compact distance, two lines inside one 32px row; it defaults on inside a
 * desktop table cell.
 */
export function CalendarDate({
  start,
  end = null,
  className,
  stacked,
}: {
  start: string | null;
  end?: string | null;
  className?: string;
  stacked?: boolean;
}) {
  const today = useHouseholdToday();
  const stack = useDenseCell(stacked);
  const label = formatDateSpan(start, end, today);
  if (stack) {
    const parts = stackedDateSpan(start, end, today);
    return (
      <StackedValue
        className={className}
        title={label}
        primary={parts.primary}
        secondary={parts.secondary}
      />
    );
  }
  const parts = /^(.*) (\([^()]+\))$/.exec(label);
  return (
    <span className={className} title={label}>
      {parts ? (
        <>
          {parts[1]} <span className="text-muted-foreground">{parts[2]}</span>
        </>
      ) : (
        label
      )}
    </span>
  );
}
