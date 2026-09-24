import type { ShoppingListItem } from "@cubby/schemas/meal";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { useState } from "react";

import { Row } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { entityDetailLink } from "~/entities/entities";
import { cn } from "~/lib/utils";

import {
  formatAmount,
  haveText,
  needText,
  shortClass,
  shortText,
  statusClass,
  statusLabel,
} from "./meal-format";
import {
  type ShoppingRow,
  toggleInSet,
  visibleContributions,
} from "./shopping-model";

/**
 * Desktop list renderer: one row per ingredient, with an expandable per-meal
 * breakdown. Stays on the `<Table>` primitives — it's a list, not a cross-tab.
 */
export function ShoppingTable({
  rows,
  excluded,
  onToggleCheck,
}: {
  rows: ShoppingRow[];
  excluded: ReadonlySet<string>;
  onToggleCheck: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  return (
    <Table
      containerClassName="hidden overflow-hidden border border-[var(--border)] sm:block print:block"
      className="table-auto"
    >
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Ingredient</TableHead>
          <TableHead className="text-right">Need</TableHead>
          <TableHead className="text-right">Have</TableHead>
          <TableHead className="text-right">Short</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <RowGroup
            key={row.key}
            row={row}
            isOpen={expanded.has(row.key)}
            perMeal={visibleContributions(row.item, excluded)}
            onToggleCheck={() => onToggleCheck(row.key)}
            onToggle={() => setExpanded((s) => toggleInSet(s, row.key))}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function RowGroup({
  row,
  isOpen,
  perMeal,
  onToggleCheck,
  onToggle,
}: {
  row: ShoppingRow;
  isOpen: boolean;
  perMeal: ShoppingListItem["perMeal"];
  onToggleCheck: () => void;
  onToggle: () => void;
}) {
  const { item, status, isChecked } = row;
  return (
    <>
      {/* Open: drop the parent's bottom border so its meal rows read as one
          cluster; the divider falls below the group's last row instead. */}
      <TableRow
        className={cn(isOpen && "border-b-0", isChecked && "opacity-60")}
      >
        <TableCell className="pr-0">
          {item.membership === "buy" && (
            <Checkbox
              aria-label={`Check ${item.name}`}
              checked={isChecked}
              onCheckedChange={onToggleCheck}
            />
          )}
        </TableCell>
        <TableCell className="whitespace-normal">
          {/* Chevron toggles, name navigates — the same split `createNameColumn`
              uses for expandable rows, so the name can be a real link. */}
          <Row align="center" gap="snug">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={isOpen}
              aria-label={isOpen ? "Collapse" : "Expand"}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              {isOpen ? (
                <CaretDownIcon className="size-3.5" />
              ) : (
                <CaretRightIcon className="size-3.5" />
              )}
            </button>
            {item.ingredientId ? (
              <Link
                {...entityDetailLink("ingredient", item.ingredientId)}
                title={item.name}
                className={cn(
                  "font-medium hover:underline",
                  isChecked && "line-through",
                )}
              >
                {item.name}
              </Link>
            ) : (
              <span
                title={item.name}
                className={cn("font-medium", isChecked && "line-through")}
              >
                {item.name}
              </span>
            )}
            <span
              className={`text-xs ${item.membership === "usuallyOnHand" ? "text-muted-foreground" : statusClass(status)}`}
            >
              ·{" "}
              {item.membership === "usuallyOnHand"
                ? "Assumed available"
                : statusLabel(status)}
            </span>
          </Row>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {needText(row)}
        </TableCell>
        <TableCell className="text-right text-muted-foreground tabular-nums">
          {haveText(row)}
        </TableCell>
        <TableCell
          className={cn("text-right font-medium tabular-nums", shortClass(row))}
        >
          {shortText(row)}
        </TableCell>
      </TableRow>
      {isOpen &&
        perMeal.map((c, i) => (
          <TableRow
            key={c.lineIndex}
            className={cn(
              "bg-muted/20 text-xs text-muted-foreground",
              i !== perMeal.length - 1 && "border-b-0",
            )}
          >
            <TableCell className="py-1" />
            <TableCell className="py-1 pl-6 whitespace-normal">
              <Link
                {...entityDetailLink("meal", c.mealId)}
                className="hover:underline"
              >
                {c.mealName || "Meal"} · {format(parseISO(c.date), "EEE M/d")}
              </Link>
              <span className="ml-1">
                — {c.scale !== 1 ? `${c.scale}× ` : ""}
                <Link
                  {...entityDetailLink("recipe", c.recipeId)}
                  title={c.recipeName}
                  className="hover:underline"
                >
                  {c.recipeName}
                </Link>
                {/* Provenance for a need that came through a sub-recipe. The
                    last hop is the useful one ("via Dough"); the full chain is
                    in the title for the rare nested case. */}
                {c.via.length > 0 && (
                  <span title={c.via.map((v) => v.name).join(" → ")}>
                    {" · via "}
                    <Link
                      {...entityDetailLink(
                        "recipe",
                        c.via[c.via.length - 1]!.recipeId,
                      )}
                      className="hover:underline"
                    >
                      {c.via[c.via.length - 1]!.name}
                    </Link>
                  </span>
                )}
              </span>
            </TableCell>
            <TableCell className="py-1 text-right tabular-nums">
              {c.needValue == null
                ? c.amount == null
                  ? "Unspecified"
                  : formatAmount(c.amount.value, c.amount.unit)
                : formatAmount(c.needValue, item.basisUnit)}
            </TableCell>
            <TableCell className="py-1" />
            <TableCell className="py-1" />
          </TableRow>
        ))}
    </>
  );
}
