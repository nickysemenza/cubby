import { Link } from "@tanstack/react-router";

import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { entityDetailLink } from "~/entities/entities";
import { cn } from "~/lib/utils";

import { formatAmount, needText, shortClass, shortText } from "./meal-format";
import type { ShoppingRow } from "./shopping-model";

/** Mobile check-off card — big tap target, no expand chrome. */
export function ShoppingCard({
  row,
  onToggleCheck,
}: {
  row: ShoppingRow;
  onToggleCheck: () => void;
}) {
  const { item, isChecked } = row;
  return (
    <Row
      as="div"
      align="center"
      gap="sm"
      className={cn(
        "w-full border border-[var(--border)] p-4 text-left",
        isChecked && "opacity-60",
      )}
    >
      {item.membership === "buy" && (
        <Checkbox
          aria-label={`Check ${item.name}`}
          checked={isChecked}
          onCheckedChange={onToggleCheck}
          className="size-11 shrink-0"
        />
      )}
      <Stack gap="tight" className="min-w-0 flex-1">
        <span className={cn("font-medium", isChecked && "line-through")}>
          {item.ingredientId ? (
            <Link
              {...entityDetailLink("ingredient", item.ingredientId)}
              className="hover:underline"
            >
              {item.name}
            </Link>
          ) : (
            item.name
          )}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          Need {needText(row)}
          {item.haveValue != null
            ? ` · have ${formatAmount(item.haveValue, item.basisUnit)}`
            : ""}
        </span>
      </Stack>
      <span
        className={cn(
          "shrink-0 text-right text-sm font-medium tabular-nums",
          shortClass(row),
        )}
      >
        {shortText(row)}
      </span>
    </Row>
  );
}
