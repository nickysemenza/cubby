import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { cn } from "~/lib/utils";
import { formatAmount, shortClass, shortText } from "./meal-format";
import type { ShoppingRow } from "./shopping-model";

/** Mobile check-off card — big tap target, no expand chrome. */
export function ShoppingCard({
  row,
  onToggleCheck,
}: {
  row: ShoppingRow;
  onToggleCheck: () => void;
}) {
  const { item, need, isChecked } = row;
  return (
    <Row
      as="button"
      type="button"
      align="center"
      gap="sm"
      onClick={onToggleCheck}
      className={cn(
        "w-full rounded-lg border border-[var(--border)] p-4 text-left",
        isChecked && "opacity-60",
      )}
    >
      <Checkbox checked={isChecked} className="pointer-events-none shrink-0" />
      <Stack gap="tight" className="min-w-0 flex-1">
        <span className={cn("font-medium", isChecked && "line-through")}>
          {item.name}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          Need {formatAmount(need, item.basisUnit)}
          {item.haveValue != null
            ? ` · have ${formatAmount(item.haveValue, item.basisUnit)}`
            : ""}
        </span>
      </Stack>
      <span
        className={cn(
          "shrink-0 text-right font-medium text-sm tabular-nums",
          shortClass(row),
        )}
      >
        {shortText(row)}
      </span>
    </Row>
  );
}
