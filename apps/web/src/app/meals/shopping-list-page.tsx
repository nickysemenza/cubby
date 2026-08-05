import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { useId } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { ShoppingCard } from "./shopping-card";
import { ShoppingTable } from "./shopping-table";
import { useShoppingList } from "./use-shopping-list";

interface ShoppingListPageProps {
  from?: string;
  to?: string;
  onRangeChange: (range: { from?: string; to?: string }) => void;
}

export function ShoppingListPage({
  from,
  to,
  onRangeChange,
}: ShoppingListPageProps) {
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    rows,
    excluded,
    toggleExcluded,
    toggleChecked,
    remaining,
    range,
  } = useShoppingList(from, to);

  const fromId = useId();
  const toId = useId();

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
            value={range.from}
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
            value={range.to}
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
                      onClick={() => toggleExcluded(m.id)}
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
                    onToggleCheck={() => toggleChecked(r.key)}
                  />
                ))}
              </Stack>

              <ShoppingTable
                rows={rows}
                excluded={excluded}
                onToggleCheck={toggleChecked}
              />
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}
