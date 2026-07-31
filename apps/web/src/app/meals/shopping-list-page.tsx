import type { IngredientAvailabilityStatus } from "@cubby/schemas/availability";
import type { ShoppingListItem } from "@cubby/schemas/meal";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { sumBy } from "es-toolkit";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { entityDetailLink } from "~/entities/entities";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTRPC } from "~/integrations/trpc/react";
import { cn } from "~/lib/utils";
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
  // Check-off state persists per date-range so a return trip to the store keeps
  // what you already grabbed. Stored as an array (Sets don't JSON-serialize).
  const [checkedKeys, setCheckedKeys] = useLocalStorage<string[]>(
    `cubby:shopping-checked:${fromStr}:${toStr}`,
    [],
  );
  const checked = useMemo(() => new Set(checkedKeys), [checkedKeys]);
  const toggleChecked = useCallback(
    (key: string) =>
      setCheckedKeys((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
      ),
    [setCheckedKeys],
  );
  const fromId = useId();
  const toId = useId();

  const { data, isLoading, isError, error, refetch } = useQuery(
    // Date-only "YYYY-MM-DD" bounds — no timezone conversion.
    api.meal.getShoppingList.queryOptions({ from: fromStr, to: toStr }),
  );

  // Recompute need/short client-side from per-meal contributions so toggling a
  // meal off is instant (no refetch). `have` is global — never re-summed.
  // Checked rows sink to the bottom (checked last), then most-short-first.
  const rows = useMemo(() => {
    if (!data) return [];
    return data.items
      .map((item) => {
        const key = item.ingredientId ?? item.name;
        const need = sumBy(
          item.perMeal.filter((c) => !excluded.has(c.mealId)),
          (c) => c.needValue,
        );
        const have = item.haveValue ?? 0;
        return {
          key,
          item,
          need,
          shortfall: Math.max(0, need - have),
          status: adjustedStatus(item, need),
          isChecked: checked.has(key),
        };
      })
      .filter((r) => r.need > EPSILON)
      .sort(
        (a, b) =>
          Number(a.isChecked) - Number(b.isChecked) ||
          b.shortfall - a.shortfall ||
          a.item.name.localeCompare(b.item.name),
      );
  }, [data, excluded, checked]);

  const remaining = rows.filter((r) => !r.isChecked).length;

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
      ) : isError ? (
        // Distinct from the empty state — a network failure must never read as
        // "no meals planned" (that lie is worst mid-shop).
        <Empty>
          <EmptyTitle>Couldn't load your shopping list</EmptyTitle>
          <EmptyDescription>
            {error.message || "Something went wrong."}
          </EmptyDescription>
          <Button type="button" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </Empty>
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
                <Badge
                  key={m.id}
                  variant={isOut ? "outline" : "secondary"}
                  className={cn(
                    // Free-form meal names — opt out of the mono-uppercase stamp.
                    "h-auto cursor-pointer px-2 py-1 font-sans text-xs normal-case tracking-normal",
                    isOut && "border-dashed text-muted-foreground line-through",
                  )}
                  render={
                    <button
                      type="button"
                      onClick={() => setExcluded((s) => toggle(s, m.id))}
                    />
                  }
                >
                  {m.name || "Meal"} · {format(parseISO(m.date), "EEE M/d")}
                </Badge>
              );
            })}
          </Row>

          {rows.length === 0 ? (
            <Description>Nothing to buy for the selected meals.</Description>
          ) : (
            <Stack gap="sm">
              <Description as="div" size="xs">
                {remaining} of {rows.length} left
              </Description>

              {/* Mobile: stacked check-off cards, usable one-handed in a store. */}
              <Stack gap="sm" className="sm:hidden">
                {rows.map((r) => (
                  <ShoppingCard
                    key={r.key}
                    row={r}
                    excluded={excluded}
                    onToggleCheck={() => toggleChecked(r.key)}
                  />
                ))}
              </Stack>

              {/* Desktop: dense table with expandable per-meal breakdown. */}
              <Table
                containerClassName="hidden overflow-hidden rounded-lg border border-[var(--border)] sm:block"
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
                  {rows.map((r) => {
                    const isOpen = expanded.has(r.key);
                    const perMeal = r.item.perMeal.filter(
                      (c) => !excluded.has(c.mealId),
                    );
                    return (
                      <RowGroup
                        key={r.key}
                        item={r.item}
                        need={r.need}
                        shortfall={r.shortfall}
                        status={r.status}
                        isChecked={r.isChecked}
                        isOpen={isOpen}
                        perMeal={perMeal}
                        onToggleCheck={() => toggleChecked(r.key)}
                        onToggle={() => setExpanded((s) => toggle(s, r.key))}
                      />
                    );
                  })}
                </TableBody>
              </Table>
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}

type ShoppingRow = {
  key: string;
  item: ShoppingListItem;
  need: number;
  shortfall: number;
  status: IngredientAvailabilityStatus;
  isChecked: boolean;
};

/** Mobile check-off card — big tap target, no expand chrome. */
function ShoppingCard({
  row,
  onToggleCheck,
}: {
  row: ShoppingRow;
  excluded: Set<string>;
  onToggleCheck: () => void;
}) {
  const { item, need, shortfall, status, isChecked } = row;
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
          shortfall > 0 ? statusClass(status) : "text-muted-foreground",
        )}
      >
        {shortfall > 0 ? formatAmount(shortfall, item.basisUnit) : "✓"}
      </span>
    </Row>
  );
}

function RowGroup({
  item,
  need,
  shortfall,
  status,
  isChecked,
  isOpen,
  perMeal,
  onToggleCheck,
  onToggle,
}: {
  item: ShoppingListItem;
  need: number;
  shortfall: number;
  status: IngredientAvailabilityStatus;
  isChecked: boolean;
  isOpen: boolean;
  perMeal: ShoppingListItem["perMeal"];
  onToggleCheck: () => void;
  onToggle: () => void;
}) {
  return (
    <>
      {/* Open: drop the parent's bottom border so its meal rows read as one
          cluster; the divider falls below the group's last row instead. */}
      <TableRow
        className={cn(isOpen && "border-b-0", isChecked && "opacity-60")}
      >
        <TableCell className="pr-0">
          <Checkbox checked={isChecked} onCheckedChange={onToggleCheck} />
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
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
            {item.ingredientShortcode ? (
              <Link
                {...entityDetailLink("ingredient", item.ingredientShortcode)}
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
            key={`${c.mealId}-${c.recipeId}-${c.needValue}-${c.scale}`}
            className={cn(
              "bg-muted/20 text-muted-foreground text-xs",
              i !== perMeal.length - 1 && "border-b-0",
            )}
          >
            <TableCell className="py-1" />
            <TableCell className="whitespace-normal py-1 pl-6">
              <Link
                {...entityDetailLink("meal", c.mealShortcode)}
                className="hover:underline"
              >
                {c.mealName || "Meal"} · {format(parseISO(c.date), "EEE M/d")}
              </Link>
              <span className="ml-1">
                — {c.scale !== 1 ? `${c.scale}× ` : ""}
                <Link
                  {...entityDetailLink("recipe", c.recipeShortcode)}
                  title={c.recipeName}
                  className="hover:underline"
                >
                  {c.recipeName}
                </Link>
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
