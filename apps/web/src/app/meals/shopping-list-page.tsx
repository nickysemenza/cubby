import type { IngredientAvailabilityStatus } from "@cubby/schemas/availability";
import type { ShoppingListItem } from "@cubby/schemas/meal";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { sumBy } from "es-toolkit";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { formatAmount, statusClass, statusLabel } from "./meal-format";
import { getDefaultShoppingRange } from "./meal-search";

const EPSILON = 1e-6;

interface ShoppingListPageProps {
  from?: string;
  to?: string;
  onRangeChange: (range: { from?: string; to?: string }) => void;
}

/** Recompute an item's status from its (post-exclusion) adjusted need. */
const adjustedStatus = (
  item: ShoppingListItem,
  need: number,
): IngredientAvailabilityStatus => {
  // haveValue===null is either "missing" (no inventory) or "unconvertible"
  // (inventory exists but units don't reconcile) — keep the server's verdict
  // rather than collapsing both to "unconvertible".
  if (item.haveValue == null) return item.status;
  if (item.haveValue + EPSILON >= need) return "ok";
  if (item.haveValue > 0) return "short";
  return "missing";
};

export function ShoppingListPage({
  from,
  to,
  onRangeChange,
}: ShoppingListPageProps) {
  const api = useTRPC();

  const defaultRange = useMemo(() => getDefaultShoppingRange(), []);
  const fromStr = from ?? defaultRange.from;
  const toStr = to ?? defaultRange.to;
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const fromId = useId();
  const toId = useId();

  const { data, isLoading } = useQuery(
    // Date-only "YYYY-MM-DD" bounds — no timezone conversion.
    api.meal.getShoppingList.queryOptions({ from: fromStr, to: toStr }),
  );

  // Recompute need/short client-side from per-meal contributions so toggling a
  // meal off is instant (no refetch). `have` is global — never re-summed.
  const rows = useMemo(() => {
    if (!data) return [];
    return data.items
      .map((item) => {
        const need = sumBy(
          item.perMeal.filter((c) => !excluded.has(c.mealId)),
          (c) => c.needValue,
        );
        const have = item.haveValue ?? 0;
        return {
          item,
          need,
          shortfall: Math.max(0, need - have),
          status: adjustedStatus(item, need),
        };
      })
      .filter((r) => r.need > EPSILON)
      .sort(
        (a, b) =>
          b.shortfall - a.shortfall || a.item.name.localeCompare(b.item.name),
      );
  }, [data, excluded]);

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  return (
    <Stack>
      <Row align="end" wrap gap="md">
        <Stack gap="xs">
          <label htmlFor={fromId} className="text-muted-foreground text-xs">
            From
          </label>
          <Input
            id={fromId}
            type="date"
            value={fromStr}
            className="h-8 w-40"
            onChange={(e) =>
              onRangeChange({ from: e.target.value || undefined, to })
            }
          />
        </Stack>
        <Stack gap="xs">
          <label htmlFor={toId} className="text-muted-foreground text-xs">
            To
          </label>
          <Input
            id={toId}
            type="date"
            value={toStr}
            className="h-8 w-40"
            onChange={(e) =>
              onRangeChange({ from, to: e.target.value || undefined })
            }
          />
        </Stack>
      </Row>

      {isLoading ? (
        <SimpleLoading text="Adding up what you need..." />
      ) : !data || data.meals.length === 0 ? (
        <Description>
          No meals planned in this range.{" "}
          <Link to="/meals" className="underline">
            Plan some meals
          </Link>
          .
        </Description>
      ) : (
        <>
          {/* Meal include/exclude toggles */}
          <Row wrap gap="sm">
            {data.meals.map((m) => {
              const isOut = excluded.has(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setExcluded((s) => toggle(s, m.id))}
                  className={
                    isOut
                      ? "rounded-full border border-dashed px-2 py-1 text-muted-foreground text-xs line-through"
                      : "rounded-full border bg-card px-2 py-1 text-xs"
                  }
                >
                  {m.name || "Meal"} · {format(parseISO(m.date), "EEE M/d")}
                </button>
              );
            })}
          </Row>

          {rows.length === 0 ? (
            <Description>Nothing to buy for the selected meals.</Description>
          ) : (
            <Table
              containerClassName="overflow-hidden rounded-lg border border-[var(--border)]"
              className="table-auto"
            >
              <TableHeader>
                <TableRow>
                  <TableHead>Ingredient</TableHead>
                  <TableHead className="text-right">Need</TableHead>
                  <TableHead className="text-right">Have</TableHead>
                  <TableHead className="text-right">Short</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ item, need, shortfall, status }) => {
                  const key = item.ingredientId ?? item.name;
                  const isOpen = expanded.has(key);
                  const perMeal = item.perMeal.filter(
                    (c) => !excluded.has(c.mealId),
                  );
                  return (
                    <RowGroup
                      key={key}
                      item={item}
                      need={need}
                      shortfall={shortfall}
                      status={status}
                      isOpen={isOpen}
                      perMeal={perMeal}
                      onToggle={() => setExpanded((s) => toggle(s, key))}
                    />
                  );
                })}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </Stack>
  );
}

function RowGroup({
  item,
  need,
  shortfall,
  status,
  isOpen,
  perMeal,
  onToggle,
}: {
  item: ShoppingListItem;
  need: number;
  shortfall: number;
  status: IngredientAvailabilityStatus;
  isOpen: boolean;
  perMeal: ShoppingListItem["perMeal"];
  onToggle: () => void;
}) {
  return (
    <>
      {/* Open: drop the parent's bottom border so its meal rows read as one
          cluster; the divider falls below the group's last row instead. */}
      <TableRow className={cn(isOpen && "border-b-0")}>
        <TableCell className="whitespace-normal">
          <Row
            as="button"
            type="button"
            align="center"
            gap="snug"
            onClick={onToggle}
            className="text-left hover:underline"
          >
            {isOpen ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="font-medium">{item.name}</span>
            <span className={`text-xs ${statusClass(status)}`}>
              · {statusLabel(status)}
            </span>
          </Row>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {formatAmount(need, item.basisUnit)}
        </TableCell>
        <TableCell className="text-right text-muted-foreground tabular-nums">
          {item.haveValue == null
            ? "—"
            : formatAmount(item.haveValue, item.basisUnit)}
        </TableCell>
        <TableCell
          className={cn(
            "text-right font-medium tabular-nums",
            shortfall > 0 ? statusClass(status) : "text-muted-foreground",
          )}
        >
          {shortfall > 0 ? formatAmount(shortfall, item.basisUnit) : "✓"}
        </TableCell>
      </TableRow>
      {isOpen &&
        perMeal.map((c, i) => (
          <TableRow
            key={`${c.mealId}-${c.recipeId}-${i}`}
            className={cn(
              "bg-muted/20 text-muted-foreground text-xs",
              i !== perMeal.length - 1 && "border-b-0",
            )}
          >
            <TableCell className="whitespace-normal py-1 pl-6">
              <Link
                to="/meals/$id"
                params={{ id: c.mealId }}
                className="hover:underline"
              >
                {c.mealName || "Meal"} · {format(parseISO(c.date), "EEE M/d")}
              </Link>
              <span className="ml-1">
                — {c.scale !== 1 ? `${c.scale}× ` : ""}
                {c.recipeName}
              </span>
            </TableCell>
            <TableCell className="py-1 text-right tabular-nums">
              {formatAmount(c.needValue, item.basisUnit)}
            </TableCell>
            <TableCell className="py-1" />
            <TableCell className="py-1" />
          </TableRow>
        ))}
    </>
  );
}
