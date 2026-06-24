import type { IngredientAvailabilityStatus } from "@cubby/schemas/availability";
import type { ShoppingListItem } from "@cubby/schemas/meal";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { addDays, format, parseISO, startOfWeek } from "date-fns";
import { sumBy } from "es-toolkit";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/trpc/react";
import { formatAmount, statusClass, statusLabel } from "./meal-format";

const EPSILON = 1e-6;

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

export function ShoppingListPage() {
  const api = useTRPC();

  const [fromStr, setFromStr] = useState(() =>
    format(startOfWeek(new Date(), { weekStartsOn: 0 }), "yyyy-MM-dd"),
  );
  const [toStr, setToStr] = useState(() =>
    format(
      addDays(startOfWeek(new Date(), { weekStartsOn: 0 }), 6),
      "yyyy-MM-dd",
    ),
  );
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <label htmlFor={fromId} className="text-muted-foreground text-xs">
            From
          </label>
          <Input
            id={fromId}
            type="date"
            value={fromStr}
            className="h-8 w-40"
            onChange={(e) => setFromStr(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={toId} className="text-muted-foreground text-xs">
            To
          </label>
          <Input
            id={toId}
            type="date"
            value={toStr}
            className="h-8 w-40"
            onChange={(e) => setToStr(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <SimpleLoading text="Adding up what you need..." />
      ) : !data || data.meals.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No meals planned in this range.{" "}
          <Link to="/meals" className="underline">
            Plan some meals
          </Link>
          .
        </p>
      ) : (
        <>
          {/* Meal include/exclude toggles */}
          <div className="flex flex-wrap gap-2">
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
          </div>

          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing to buy for the selected meals.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-[var(--border-chunky)]">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-xs">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium">
                      Ingredient
                    </th>
                    <th className="px-2 py-2 text-right font-medium">Need</th>
                    <th className="px-2 py-2 text-right font-medium">Have</th>
                    <th className="px-2 py-2 text-right font-medium">Short</th>
                  </tr>
                </thead>
                <tbody>
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
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
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
      <tr className="border-t">
        <td className="px-2 py-2">
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1.5 text-left hover:underline" /* tight: chevron+label */
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
          </button>
        </td>
        <td className="px-2 py-2 text-right tabular-nums">
          {formatAmount(need, item.basisUnit)}
        </td>
        <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">
          {item.haveValue == null
            ? "—"
            : formatAmount(item.haveValue, item.basisUnit)}
        </td>
        <td
          className={`px-2 py-2 text-right font-medium tabular-nums ${shortfall > 0 ? statusClass(status) : "text-muted-foreground"}`}
        >
          {shortfall > 0 ? formatAmount(shortfall, item.basisUnit) : "✓"}
        </td>
      </tr>
      {isOpen &&
        perMeal.map((c, i) => (
          <tr
            key={`${c.mealId}-${c.recipeId}-${i}`}
            className="bg-muted/20 text-muted-foreground text-xs"
          >
            <td className="py-1 pr-2 pl-6">
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
            </td>
            <td className="py-1 pr-2 text-right tabular-nums">
              {formatAmount(c.needValue, item.basisUnit)}
            </td>
            <td />
            <td />
          </tr>
        ))}
    </>
  );
}
