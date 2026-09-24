import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CopyIcon as Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
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
    isFetching,
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

  const buyRows = rows.filter((row) => row.item.membership === "buy");
  const fromId = useId();
  const toId = useId();

  return (
    <Stack>
      <Row align="end" wrap gap="md" className="w-full print:hidden">
        <Stack gap="xs">
          <label htmlFor={fromId} className="text-xs text-muted-foreground">
            From
          </label>
          <DatePickerInput
            id={fromId}
            value={range.from || null}
            clearable
            className="w-full sm:w-44"
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
            className="w-full sm:w-44"
            onChange={(value) =>
              onRangeChange({ from, to: value ?? undefined })
            }
          />
        </Stack>
        <Row
          gap="sm"
          align="center"
          className="ml-auto w-full justify-end sm:w-auto print:hidden"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11"
            disabled={
              isFetching || (rows.length === 0 && unexpanded.length === 0)
            }
            onClick={() => {
              void copyText(
                shoppingRowsToText(
                  rows,
                  range,
                  unexpanded.map((gap) => `${gap.name}: ${gap.reason}`),
                ),
              );
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
            className="min-h-11"
            disabled={remaining === buyRows.length}
            onClick={clearChecked}
          >
            <RotateCcw />
            Clear ticks
          </Button>
        </Row>
      </Row>

      {isLoading || isFetching ? (
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
                      aria-label={`Toggle ${m.name || format(parseISO(m.date), "EEE M/d")}`}
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

          {buyRows.length === 0 && (
            <Description>Nothing to buy for the selected meals.</Description>
          )}
          {(
            [
              ["buy", "To buy"],
              ["usuallyOnHand", "Usually on hand"],
              ["covered", "Recorded stock covers"],
            ] as const
          ).map(([membership, heading]) => {
            const sectionRows = rows.filter(
              (row) => row.item.membership === membership,
            );
            if (sectionRows.length === 0 && membership !== "usuallyOnHand")
              return null;
            return (
              <Stack
                key={membership}
                gap="sm"
                as="section"
                aria-label={heading}
              >
                <Row align="baseline" gap="sm" wrap>
                  <h2 className="text-sm font-semibold">{heading}</h2>
                  {membership === "buy" && (
                    <Description as="div" size="xs">
                      {remaining} of {buyRows.length} left
                    </Description>
                  )}
                  {membership === "buy" && data.pricedItems > 0 && (
                    <Description as="div" size="xs" className="tabular-nums">
                      ~{formatCurrency(data.estimatedTotal)} for{" "}
                      {data.pricedItems} of {buyRows.length} priced
                    </Description>
                  )}
                </Row>
                {membership === "usuallyOnHand" && (
                  <Description>
                    Assumed available. Required quantities are shown for review;
                    recorded inventory is unchanged.
                  </Description>
                )}
                {sectionRows.length === 0 ? (
                  <Description>
                    No usually-on-hand ingredients needed.
                  </Description>
                ) : (
                  <>
                    <Stack gap="sm" className="sm:hidden print:hidden">
                      {view === "matrix" && (
                        <Description as="div" size="xs">
                          Matrix view needs a wider screen — showing the list.
                        </Description>
                      )}
                      {sectionRows.map((r) => (
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
                          rows={sectionRows}
                          columns={columns}
                          groups={groups}
                          unexpanded={unexpanded}
                          excluded={excluded}
                          onToggleCheck={toggleChecked}
                        />
                      ))
                      .with("list", () => (
                        <ShoppingTable
                          rows={sectionRows}
                          excluded={excluded}
                          onToggleCheck={toggleChecked}
                        />
                      ))
                      .exhaustive()}
                  </>
                )}
              </Stack>
            );
          })}
        </>
      )}
    </Stack>
  );
}
