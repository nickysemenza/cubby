import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { useMemo } from "react";
import { Row } from "~/components/layout";
import { CrossTabTable } from "~/components/matrix/cross-tab-table";
import type { CrossTabColumn } from "~/components/matrix/group-columns";
import { HEAT_CLASSES, heatBucket } from "~/components/matrix/heat-scale";
import { totalCell } from "~/components/matrix/matrix-chrome";
import { Checkbox } from "~/components/ui/checkbox";
import { entityDetailLink } from "~/entities/entities";
import { cn } from "~/lib/utils";
import {
  formatAmount,
  haveText,
  needText,
  shortClass,
  shortText,
  statusClass,
} from "./meal-format";
import type {
  ShoppingLineColumn,
  ShoppingMealGroup,
  ShoppingRow,
} from "./shopping-model";

// Rows are ingredients, columns are planned (meal, recipe) lines, cells are
// that line's scaled contribution — the cross-meal sum the list view keeps
// behind a disclosure triangle. Need/Have/Short stay pinned right.

// Fixed layout: the pinned columns' `right-*` offsets are absolute, so they
// only line up if every pinned column is exactly `pinned` wide, which an auto
// layout can't promise. 96px = right-24, so the offsets below are 0 / 24 / 48.
// (80px was narrower than a four-significant-figure gram value, which wrapped.)
const LAYOUT = { rowHeader: 224, column: 96, pinned: 96 };

const PINNED = [
  {
    key: "need",
    label: "Need",
    stickyRight: "right-48",
    className: cn("whitespace-nowrap", totalCell),
  },
  {
    key: "have",
    label: "Have",
    stickyRight: "right-24",
    className: "whitespace-nowrap text-muted-foreground",
  },
  {
    key: "short",
    label: "Short",
    stickyRight: "right-0",
    className: "whitespace-nowrap",
  },
];

export function ShoppingMatrix({
  rows,
  columns,
  groups,
  onToggleCheck,
}: {
  rows: ShoppingRow[];
  columns: ShoppingLineColumn[];
  groups: ShoppingMealGroup[];
  onToggleCheck: (key: string) => void;
}) {
  const crossTabColumns = useMemo(
    (): CrossTabColumn<ShoppingLineColumn>[] =>
      columns.map((column) => ({
        key: column.key,
        data: column,
        groupKey: column.mealId,
      })),
    [columns],
  );

  const groupByMealId = useMemo(
    () => new Map(groups.map((g) => [g.mealId, g])),
    [groups],
  );

  /** Per row: its cell values by column key, and the row's own max. */
  const cells = useMemo(() => {
    const byRow = new Map<
      string,
      { values: Map<string, number>; max: number }
    >();
    for (const row of rows) {
      const values = new Map<string, number>();
      let max = 0;
      for (const c of row.item.perMeal) {
        const key = String(c.lineIndex);
        values.set(key, (values.get(key) ?? 0) + c.needValue);
      }
      for (const v of values.values()) if (v > max) max = v;
      byRow.set(row.key, { values, max });
    }
    return byRow;
  }, [rows]);

  const shortCount = rows.filter((r) => r.shortfall > 0).length;

  return (
    <div className="hidden overflow-hidden rounded-lg border border-[var(--border)] sm:block">
      <CrossTabTable<ShoppingRow, ShoppingLineColumn>
        cornerLabel="Ingredient"
        surface="background"
        rowHover
        layout={LAYOUT}
        caption="Ingredients by planned recipe"
        columns={crossTabColumns}
        rows={rows.map((row) => ({ key: row.key, data: row }))}
        pinned={PINNED}
        rowClassName={({ data: row }) => cn(row.isChecked && "opacity-60")}
        renderGroupHeader={(mealId, runColumns) => {
          const group = groupByMealId.get(mealId);
          const first = runColumns[0]?.data;
          return (
            <span className="normal-case tracking-normal">
              <Link
                {...entityDetailLink("meal", mealId)}
                className="font-medium hover:underline"
              >
                {group?.label ?? "Meal"}
              </Link>
              {first && (
                <span className="text-muted-foreground">
                  {" · "}
                  {format(parseISO(first.date), "EEE M/d")}
                </span>
              )}
            </span>
          );
        }}
        renderColumnHeader={({ data: column }) => (
          <>
            <Link
              {...entityDetailLink("recipe", column.recipeId)}
              title={column.recipeName}
              className="block truncate font-medium normal-case tracking-normal hover:underline"
            >
              {column.recipeName}
            </Link>
            {column.scale !== 1 && (
              <span className="font-normal text-2xs text-primary normal-case tracking-normal">
                {column.scale}×
              </span>
            )}
          </>
        )}
        renderRowHeader={({ data: row }) => (
          <Row align="center" gap="snug">
            <Checkbox
              checked={row.isChecked}
              onCheckedChange={() => onToggleCheck(row.key)}
              className="shrink-0"
            />
            {row.item.ingredientId ? (
              <Link
                {...entityDetailLink("ingredient", row.item.ingredientId)}
                title={row.item.name}
                className={cn(
                  "truncate hover:underline",
                  row.isChecked && "line-through",
                )}
              >
                {row.item.name}
              </Link>
            ) : (
              <span
                title={row.item.name}
                className={cn("truncate", row.isChecked && "line-through")}
              >
                {row.item.name}
              </span>
            )}
            <span
              className={cn("shrink-0 text-2xs", statusClass(row.status))}
              aria-hidden
            >
              ●
            </span>
          </Row>
        )}
        // Shading answers one question: when an ingredient is needed by several
        // planned lines, which ones drive it? So it's scaled against the row's
        // OWN max — every row is a different unit (500 g flour vs 2 eggs), and
        // a grid-wide scale would just paint whichever unit has the bigger
        // numbers, which is an artifact rather than information.
        //
        // Single-source rows get no fill at all. Against its own max a lone
        // cell is always the darkest bucket, so shading it says nothing while
        // drowning out the split rows that are the point.
        cellClassName={({ key }, column) => {
          const cell = cells.get(key);
          const value = cell?.values.get(column.key);
          if (value == null || !cell || cell.values.size < 2) return undefined;
          return HEAT_CLASSES[heatBucket(value, cell.max)];
        }}
        renderCell={({ key, data: row }, column) => {
          const value = cells.get(key)?.values.get(column.key);
          // Same WASM formatter the Need column uses, so a cell and its row
          // total can never render by different rules.
          return value == null ? null : formatAmount(value, row.item.basisUnit);
        }}
        renderPinnedCell={({ data: row }, pinned) => {
          if (pinned.key === "need") return needText(row);
          if (pinned.key === "have") return haveText(row);
          return <span className={shortClass(row)}>{shortText(row)}</span>;
        }}
        // Counts, not sums: adding grams down a column across flour, water and
        // salt is dimensionally meaningless.
        footer={[
          {
            key: "counts",
            label: `${rows.length} ingredient${rows.length === 1 ? "" : "s"}`,
            cell: (columnKey) => {
              const n = rows.filter((r) =>
                cells.get(r.key)?.values.has(columnKey),
              ).length;
              return n === 0 ? null : n;
            },
            pinnedCell: (pinnedKey) =>
              pinnedKey === "short" && shortCount > 0
                ? `${shortCount} short`
                : null,
          },
        ]}
      />
    </div>
  );
}
