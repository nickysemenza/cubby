import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { Copy, RotateCcw } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";

import { DatePickerInput } from "~/app/_components/date-picker-input";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { copyText } from "~/lib/clipboard";
import { cn, formatCurrency } from "~/lib/utils";

import type { ShoppingListView } from "./meal-search";
import { ShoppingCard } from "./shopping-card";
import { ShoppingMatrix } from "./shopping-matrix";
import { shoppingRowsToText } from "./shopping-model";
import { ShoppingOmissionNote } from "./shopping-omission-note";
import { ShoppingTable } from "./shopping-table";
import { useShoppingList } from "./use-shopping-list";

interface ShoppingListPageProps {
  view: ShoppingListView;
  from?: string;
  to?: string;
  excluded: readonly string[];
  onRangeChange: (range: { from?: string; to?: string }) => void;
  onExcludedChange: (next: ReadonlySet<string>) => void;
}

export function ShoppingListPage({
  view,
  from,
  to,
  excluded: excludedParam,
  onRangeChange,
  onExcludedChange,
}: ShoppingListPageProps) {
  const {
    data,
    isLoading: listLoading,
    isError,
    error,
    refetch,
    rows,
    columns,
    groups,
    unexpanded,
    omittedMeals,
    excluded,
    toggleExcluded,
    toggleChecked,
    clearChecked,
    remaining,
    range,
  } = useShoppingList(from, to, excludedParam, onExcludedChange);

  // Hydration-stable: the server renders this branch with no list, while the
  // client's first render already has the streamed one. See useHydratedLoading.
  const isLoading = useHydratedLoading(listLoading);

  const fromId = useId();
  const toId = useId();

  return (
    <Stack>
      <Row align="end" wrap gap="md" className="print:hidden">
        <Stack gap="xs">
          <label htmlFor={fromId} className="text-xs text-muted-foreground">
            From
          </label>
          <DatePickerInput
            id={fromId}
            value={range.from || null}
            clearable
            className="w-44"
            onChange={(value) =>
              onRangeChange({ from: value ?? undefined, to })
            }
          />
        </Stack>
        <Stack gap="xs">
          <label htmlFor={toId} className="text-xs text-muted-foreground">
            To
          </label>
          <DatePickerInput
            id={toId}
            value={range.to || null}
            clearable
            className="w-44"
            onChange={(value) =>
              onRangeChange({ from, to: value ?? undefined })
            }
          />
        </Stack>
        <Row gap="sm" align="center" className="ml-auto print:hidden">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rows.length === 0}
            onClick={() => {
              void copyText(shoppingRowsToText(rows, range));
              toast.success("Shopping list copied");
            }}
          >
            <Copy />
            Copy
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remaining === rows.length}
            onClick={clearChecked}
          >
            <RotateCcw />
            Clear ticks
          </Button>
        </Row>
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
          {/* Meal include/exclude toggles. Interactive chrome — on paper the
              excluded ones simply aren't in the list. */}
          <Row wrap gap="sm" className="print:hidden">
            {data.meals.map((m) => {
              const isOut = excluded.has(m.id);
              return (
                <Badge
                  key={m.id}
                  variant={isOut ? "outline" : "secondary"}
                  className={cn(
                    // Free-form meal names — opt out of the mono-uppercase stamp.
                    "h-auto cursor-pointer px-2 py-1 font-sans text-xs tracking-normal normal-case",
                    isOut && "border-dashed text-muted-foreground line-through",
                  )}
                  render={
                    <button
                      type="button"
                      onClick={() => toggleExcluded(m.id)}
                    />
                  }
                >
                  {m.name || format(parseISO(m.date), "EEE M/d")}
                  {m.name ? ` · ${format(parseISO(m.date), "EEE M/d")}` : ""}
                </Badge>
              );
            })}
          </Row>

          {/* Above the renderer switch: an omission in the DATA, so it holds
              whichever way the rows are drawn — and whether or not there are
              any rows at all. */}
          <ShoppingOmissionNote
            unexpanded={unexpanded}
            omittedMeals={omittedMeals}
          />

          {rows.length === 0 ? (
            <Description>Nothing to buy for the selected meals.</Description>
          ) : (
            <Stack gap="sm">
              <Row align="baseline" gap="sm" wrap>
                <Description as="div" size="xs">
                  {remaining} of {rows.length} left
                </Description>
                {data.pricedItems > 0 && (
                  <Description as="div" size="xs" className="tabular-nums">
                    {/* The count is not decoration: a total covering 4 of 11
                        rows must not read as the price of the trip. */}
                    ~{formatCurrency(data.estimatedTotal)} for{" "}
                    {data.pricedItems} of {data.items.length} priced
                  </Description>
                )}
              </Row>

              {/* Mobile: stacked check-off cards, usable one-handed in a
                  store. A 15-column cross-tab is not, so `?view=matrix` still
                  gets the cards here — but says so, rather than letting a
                  shared link quietly show something else. */}
              <Stack gap="sm" className="sm:hidden">
                {view === "matrix" && (
                  <Description as="div" size="xs">
                    Matrix view needs a wider screen — showing the list.
                  </Description>
                )}
                {rows.map((r) => (
                  <ShoppingCard
                    key={r.key}
                    row={r}
                    onToggleCheck={() => toggleChecked(r.key)}
                  />
                ))}
              </Stack>

              {match(view)
                .with("matrix", () => (
                  <ShoppingMatrix
                    rows={rows}
                    columns={columns}
                    groups={groups}
                    unexpanded={unexpanded}
                    excluded={excluded}
                    onToggleCheck={toggleChecked}
                  />
                ))
                .with("list", () => (
                  <ShoppingTable
                    rows={rows}
                    excluded={excluded}
                    onToggleCheck={toggleChecked}
                  />
                ))
                .exhaustive()}
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}
