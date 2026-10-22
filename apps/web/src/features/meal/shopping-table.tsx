import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { entityDetailLink } from "~/entity/entities";
import RTable from "~/entity/table/table";
import { formatCalendarDay } from "~/lib/date-format";
import { cn } from "~/lib/utils";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { Checkbox } from "~/ui/primitives/checkbox";
import { StaticTable } from "~/ui/primitives/static-table";

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

const helper = createCubbyColumnHelper<ShoppingRow>();
const rowId = (row: ShoppingRow) => row.key;
const search = {
  text: (row: ShoppingRow) => row.item.name,
  placeholder: "Search ingredients",
};

function MealBreakdown({
  row,
  excluded,
}: {
  row: ShoppingRow;
  excluded: ReadonlySet<string>;
}) {
  return (
    <StaticTable
      aria-label={`Meals needing ${row.item.name}`}
      rows={visibleContributions(row.item, excluded)}
      rowKey={(contribution) => String(contribution.lineIndex)}
      columns={[
        {
          id: "meal",
          header: "Meal",
          cell: (c) => (
            <Link
              {...entityDetailLink("meal", c.mealId)}
              className="hover:underline"
            >
              {c.mealName || "Meal"} ·{" "}
              {formatCalendarDay(c.date, "weekdayNumeric")}
            </Link>
          ),
        },
        {
          id: "recipe",
          header: "Recipe",
          cell: (c) => {
            const via = c.via.at(-1);
            return (
              <span>
                {c.scale !== 1 ? `${c.scale}× ` : ""}
                <Link
                  {...entityDetailLink("recipe", c.recipeId)}
                  className="hover:underline"
                >
                  {c.recipeName}
                </Link>
                {via ? (
                  <span title={c.via.map((v) => v.name).join(" → ")}>
                    {" "}
                    · via{" "}
                    <Link
                      {...entityDetailLink("recipe", via.recipeId)}
                      className="hover:underline"
                    >
                      {via.name}
                    </Link>
                  </span>
                ) : null}
              </span>
            );
          },
        },
        {
          id: "need",
          header: "Need",
          headClassName: "text-right",
          cellClassName: "text-right",
          cell: (c) =>
            c.needValue == null
              ? c.amount == null
                ? "Unspecified"
                : formatAmount(c.amount.value, c.amount.unit)
              : formatAmount(c.needValue, row.item.basisUnit),
        },
      ]}
    />
  );
}

/** Shared interactive rows; checked shopping state stays separate from bulk selection. */
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
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ShoppingRow>((add) => {
        add(
          helper.display({
            id: "check",
            header: "Checked",
            size: 60,
            meta: attachCubbyColumnMeta<ShoppingRow>({
              mobile: { slot: "trailing", interactive: true, priority: 0 },
            }),
            cell: ({ row: { original: row } }) =>
              row.item.membership === "buy" ? (
                <Checkbox
                  aria-label={`Check ${row.item.name}`}
                  checked={row.isChecked}
                  onCheckedChange={() => onToggleCheck(row.key)}
                />
              ) : null,
          }),
        );
        add(
          helper.accessor((row) => row.item.name, {
            id: "ingredient",
            header: "Ingredient",
            size: 320,
            meta: attachCubbyColumnMeta<ShoppingRow>({
              mobile: { slot: "title", priority: 0 },
            }),
            cell: ({ row: { original: row } }) => (
              <span className="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={`${expanded.has(row.key) ? "Collapse" : "Expand"} ${row.item.name}`}
                  aria-expanded={expanded.has(row.key)}
                  onClick={() =>
                    setExpanded((current) => toggleInSet(current, row.key))
                  }
                  className="flex min-h-8 items-center text-muted-foreground"
                >
                  {expanded.has(row.key) ? (
                    <CaretDownIcon className="size-3.5" />
                  ) : (
                    <CaretRightIcon className="size-3.5" />
                  )}
                </button>
                {row.item.ingredientId ? (
                  <Link
                    {...entityDetailLink("ingredient", row.item.ingredientId)}
                    className={cn(
                      "font-medium hover:underline",
                      row.isChecked && "line-through",
                    )}
                  >
                    {row.item.name}
                  </Link>
                ) : (
                  <span className={cn(row.isChecked && "line-through")}>
                    {row.item.name}
                  </span>
                )}
              </span>
            ),
          }),
        );
        add(
          helper.accessor(
            (row) =>
              row.item.membership === "usuallyOnHand"
                ? "Assumed available"
                : statusLabel(row.status),
            {
              id: "status",
              header: "Status",
              size: 160,
              meta: attachCubbyColumnMeta<ShoppingRow>({
                mobile: { slot: "subtitle", priority: 0 },
                filterConfig: { placeholder: "Filter status" },
              }),
              cell: ({ row: { original: row }, getValue }) => (
                <span className={statusClass(row.status)}>{getValue()}</span>
              ),
            },
          ),
        );
        add(
          helper.accessor((row) => row.need, {
            id: "need",
            header: "Need",
            size: 110,
            meta: attachCubbyColumnMeta<ShoppingRow>({
              numeric: true,
              mobile: { slot: "meta", priority: 0, showWhenEmpty: true },
            }),
            cell: ({ row }) => needText(row.original),
          }),
        );
        add(
          helper.accessor((row) => row.item.haveValue, {
            id: "have",
            header: "Have",
            size: 110,
            meta: attachCubbyColumnMeta<ShoppingRow>({
              numeric: true,
              mobile: { slot: "meta", priority: 1, showWhenEmpty: true },
            }),
            cell: ({ row }) => haveText(row.original),
          }),
        );
        add(
          helper.accessor((row) => row.shortfall, {
            id: "short",
            header: "Short",
            size: 110,
            meta: attachCubbyColumnMeta<ShoppingRow>({
              numeric: true,
              mobile: { slot: "meta", priority: 2, showWhenEmpty: true },
            }),
            cell: ({ row: { original: row } }) => (
              <span className={shortClass(row)}>{shortText(row)}</span>
            ),
          }),
        );
      }),
    [expanded, onToggleCheck],
  );
  const table = useLocalTable({
    rows,
    columns,
    getRowId: rowId,
    search,
    rowContentVersion: expanded,
  });
  return (
    <RTable
      table={table}
      printable
      embedded
      ariaLabel="Shopping ingredients"
      withoutImages="Shopping needs are computed ingredient aggregates, including unresolved ingredient names."
      onRowClick={(row) =>
        setExpanded((current) => toggleInSet(current, row.id))
      }
      disableMobileDetailsHref
      getRowClassName={(row) =>
        row.original.isChecked ? "opacity-60" : undefined
      }
      rowDetail={{
        openIds: expanded,
        render: (row) => (
          <MealBreakdown row={row.original} excluded={excluded} />
        ),
      }}
      renderMobileRowFooter={(row) =>
        expanded.has(row.key) ? (
          <MealBreakdown row={row} excluded={excluded} />
        ) : null
      }
    />
  );
}
