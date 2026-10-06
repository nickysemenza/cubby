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
