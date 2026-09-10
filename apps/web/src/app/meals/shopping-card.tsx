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
        "w-full border border-[var(--border)] p-3 text-left sm:p-4",
        isChecked && "bg-muted/30",
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
        <span
          className={cn(
            "min-w-0 leading-snug font-medium break-words",
            isChecked && "text-muted-foreground line-through",
          )}
        >
          {item.ingredientId ? (
            <Link
              {...entityDetailLink("ingredient", item.ingredientId)}
              className="flex min-h-11 items-center hover:underline"
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
          "max-w-[30%] shrink-0 text-right text-sm leading-snug font-medium whitespace-normal tabular-nums",
          shortClass(row),
          isChecked && "text-muted-foreground",
        )}
      >
        {shortText(row)}
      </span>
    </Row>
  );
}
