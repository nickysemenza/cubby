import { formatDateSpan } from "~/lib/date-span";
import { useHouseholdToday } from "~/ui/hooks/use-household-today";

export function CalendarDate({
  start,
  end = null,
  className,
}: {
  start: string | null;
  end?: string | null;
  className?: string;
}) {
  const today = useHouseholdToday();
  const label = formatDateSpan(start, end, today);
  return (
    <span className={className} title={label}>
      {label}
    </span>
  );
}
