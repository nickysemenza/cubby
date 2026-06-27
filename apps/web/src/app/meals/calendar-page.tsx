import type { MealOut } from "@cubby/schemas/meal-responses";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { addDays, addWeeks, format, isSameDay, parseISO } from "date-fns";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  ShoppingCart,
  Table as TableIcon,
} from "lucide-react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useTRPC } from "~/trpc/react";
import { formatMealCost } from "./meal-format";
import {
  formatWeekSearch,
  type MealCalendarView,
  parseWeekStart,
} from "./meal-search";
import { useInvalidateMeals } from "./use-meal-mutations";

interface MealCalendarPageProps {
  view: MealCalendarView;
  week?: string;
  onViewChange: (view: MealCalendarView) => void;
  onWeekChange: (week?: string) => void;
}

export function MealCalendarPage({
  view,
  week,
  onViewChange,
  onWeekChange,
}: MealCalendarPageProps) {
  const weekStart = parseWeekStart(week);

  return (
    <Stack>
      <Row align="center" gap="xs">
        <div className="inline-flex overflow-hidden rounded-md border">
          <button
            type="button"
            onClick={() => onViewChange("calendar")}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-sm ${view === "calendar" ? "bg-accent font-medium" : "text-muted-foreground"}`} /* tight: segmented toggle icon+label */
          >
            <CalendarDays className="size-4" />
            Calendar
          </button>
          <button
            type="button"
            onClick={() => onViewChange("table")}
            className={`flex items-center gap-1.5 border-l px-2.5 py-1 text-sm ${view === "table" ? "bg-accent font-medium" : "text-muted-foreground"}`} /* tight: segmented toggle icon+label */
          >
            <TableIcon className="size-4" />
            Table
          </button>
        </div>
        <Link to="/meals/shopping-list" className="ml-auto">
          <Button type="button" variant="outline" size="sm">
            <ShoppingCart className="size-4" />
            Shopping list
          </Button>
        </Link>
      </Row>

      {view === "calendar" ? (
        <CalendarView weekStart={weekStart} onWeekChange={onWeekChange} />
      ) : (
        <TableView />
      )}
    </Stack>
  );
}

function CalendarView({
  weekStart,
  onWeekChange,
}: {
  weekStart: Date;
  onWeekChange: (week?: string) => void;
}) {
  const api = useTRPC();
  const navigate = useNavigate();
  const invalidate = useInvalidateMeals();

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  // Date-only bounds (no time) so the range matches the calendar's days exactly.
  const from = format(weekStart, "yyyy-MM-dd");
  const to = format(addDays(weekStart, 6), "yyyy-MM-dd");

  const { data: meals, isLoading } = useQuery(
    api.meal.getByDateRange.queryOptions({ from, to }),
  );

  const createMeal = useMutation(
    api.meal.create.mutationOptions({
      onSuccess: (meal) => {
        invalidate();
        void navigate({ to: "/meals/$id", params: { id: meal.id } });
      },
    }),
  );

  const today = new Date();

  return (
    <Stack>
      <Row align="center" gap="xs">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Previous week"
          onClick={() =>
            onWeekChange(formatWeekSearch(addWeeks(weekStart, -1)))
          }
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onWeekChange(undefined)}
        >
          Today
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Next week"
          onClick={() => onWeekChange(formatWeekSearch(addWeeks(weekStart, 1)))}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Description as="span" className="ml-2">
          {format(weekStart, "MMM d")} –{" "}
          {format(addDays(weekStart, 6), "MMM d, yyyy")}
        </Description>
      </Row>

      {isLoading ? (
        <SimpleLoading text="Loading your week..." />
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
          {days.map((day) => {
            const dayStr = format(day, "yyyy-MM-dd");
            const dayMeals = (meals ?? []).filter((m) => m.date === dayStr);
            const isToday = isSameDay(day, today);
            return (
              <div
                key={dayStr}
                className="flex min-h-32 flex-col gap-1.5 rounded-lg border p-2" /* tight: calendar day cell */
              >
                <Row align="center" justify="between">
                  <span className="text-muted-foreground text-xs uppercase">
                    {format(day, "EEE")}
                  </span>
                  <span
                    className={
                      isToday
                        ? "flex size-5 items-center justify-center rounded-full bg-warning/20 font-semibold text-warning text-xs"
                        : "text-muted-foreground text-xs"
                    }
                  >
                    {format(day, "d")}
                  </span>
                </Row>

                {dayMeals.map((m) => (
                  <MealChip key={m.id} meal={m} />
                ))}

                <button
                  type="button"
                  disabled={createMeal.isPending}
                  onClick={() => createMeal.mutate({ date: dayStr })}
                  className="mt-auto flex items-center justify-center gap-1 rounded-md border border-dashed py-1 text-muted-foreground text-xs transition-colors hover:bg-accent disabled:opacity-50"
                >
                  <Plus className="size-3" />
                  Meal
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Stack>
  );
}

function TableView() {
  const api = useTRPC();
  const { data, isLoading } = useQuery(
    api.meal.list.queryOptions({
      filters: {},
      sort: { orderBy: "date", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 200 },
    }),
  );

  if (isLoading) return <SimpleLoading text="Loading meals..." />;
  const meals = data?.items ?? [];
  const total = data?.meta.totalCount ?? meals.length;
  if (meals.length === 0) {
    return (
      <Description>
        No meals planned yet — switch to the calendar to add one.
      </Description>
    );
  }

  return (
    <Stack gap="sm">
      {total > meals.length && (
        <Description size="xs">
          Showing the {meals.length} most recent of {total} meals.
        </Description>
      )}
      <Table
        className="table-auto"
        containerClassName="overflow-hidden rounded-lg border border-[var(--border)]"
      >
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Meal</TableHead>
            <TableHead>Recipes</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {meals.map((m) => (
            <TableRow key={m.id}>
              <TableCell className="tabular-nums">
                <Link
                  to="/meals/$id"
                  params={{ id: m.id }}
                  className="hover:underline"
                >
                  {format(parseISO(m.date), "EEE, MMM d, yyyy")}
                </Link>
              </TableCell>
              <TableCell>{m.name || "—"}</TableCell>
              <TableCell className="whitespace-normal text-muted-foreground">
                {m.recipes.length === 0
                  ? "—"
                  : m.recipes
                      .map(
                        (r) =>
                          `${r.scale !== 1 ? `${r.scale}× ` : ""}${r.recipe.name}`,
                      )
                      .join(", ")}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMealCost(m.totals)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Stack>
  );
}

function MealChip({ meal }: { meal: MealOut }) {
  return (
    <Link
      to="/meals/$id"
      params={{ id: meal.id }}
      className="flex flex-col gap-0.5 rounded-md border bg-card p-1.5 text-xs transition-colors hover:bg-accent" /* tight: calendar meal chip */
    >
      <Row align="center" justify="between" gap="xs">
        <span className="truncate font-medium">{meal.name || "Meal"}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {formatMealCost(meal.totals)}
        </span>
      </Row>
      {meal.recipes.length === 0 ? (
        <span className="text-muted-foreground italic">empty</span>
      ) : (
        meal.recipes.map((r) => (
          <span key={r.id} className="truncate text-muted-foreground">
            {r.scale !== 1 ? `${r.scale}× ` : ""}
            {r.recipe.name}
          </span>
        ))
      )}
    </Link>
  );
}
