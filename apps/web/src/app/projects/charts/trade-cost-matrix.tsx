import { isPrincipalExpense } from "@cubby/schemas/expense-line-kind";
import type { ExpenseOut, Trade } from "@cubby/schemas/project";
import { sumBy } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { Fragment, type ReactElement, useMemo } from "react";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";
import { HEAT_CLASSES, heatBucket } from "~/components/matrix/heat-scale";
import {
  bodyRule,
  cellMono,
  EMPTY_MARK,
  emptyCell,
  footRule,
  headRule,
  stickyRowHeaderCard,
  totalCell,
} from "~/components/matrix/matrix-chrome";
import {
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
} from "~/components/ui/preview-card";
import { cn, formatCurrency } from "~/lib/utils";

import { capitalize, TRADE_LABELS } from "../shared";
import { ChartEmpty } from "./chart-empty";
import {
  buildTradeCostPivot,
  PIVOT_COST_KEYS,
  type PivotCostKey,
} from "./trade-cost-pivot";

const interactiveCell =
  "block w-full text-right hover:ring-1 hover:ring-primary/40 hover:ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const activeCellRing = "ring-2 ring-primary ring-inset";

export type TradeCostCell = { trade: Trade; costType: PivotCostKey | null };

/** The expenses behind one cell, top 8 by magnitude + a "+N more" roll-up. */
function CellPreview({ expenses }: { expenses: ExpenseOut[] }) {
  const projectRefs = useMemo(
    () =>
      expenses.flatMap((expense) =>
        expense.projectId
          ? [{ entityType: "project" as const, entityId: expense.projectId }]
          : [],
      ),
    [expenses],
  );
  const projectImages = useEntityDisplayImages(projectRefs);
  // Sort by absolute value so a large-magnitude negative (e.g. the −$75k family
  // contribution) surfaces at the top instead of sinking into the rest bucket.
  const sorted = [...expenses].sort(
    (a, b) => Math.abs(b.cost ?? 0) - Math.abs(a.cost ?? 0),
  );
  const top = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  const restTotal = sumBy(rest, (p) => p.cost ?? 0);

  return (
    <Stack gap="tight">
      {top.map((p) => (
        <Row key={p.id} justify="between" align="baseline" gap="sm">
          <span className="truncate">
            {p.name}
            {p.projectId && p.projectName && (
              <span className="text-muted-foreground">
                {" · "}
                <EntityInlineLink
                  displayImage={
                    projectImages[
                      entityDisplayImageKey({
                        entityType: "project",
                        entityId: p.projectId,
                      })
                    ] ?? null
                  }
                  entity="project"
                  data={{ id: p.projectId, name: p.projectName }}
                  compact
                />
              </span>
            )}
          </span>
          <span className="shrink-0 font-mono tabular-nums">
            {formatCurrency(p.cost ?? 0, 0)}
          </span>
        </Row>
      ))}
      {rest.length > 0 && (
        <div className="text-muted-foreground">
          +{rest.length} more · {formatCurrency(restTotal, 0)}
        </div>
      )}
    </Stack>
  );
}

export function TradeCostMatrix({
  expenses,
  onCellClick,
  activeCell,
}: {
  expenses: ExpenseOut[];
  /** `costType: null` is a row-total click (filter by trade alone). */
  onCellClick?: (trade: Trade, costType: PivotCostKey | null) => void;
  activeCell?: TradeCostCell | null;
}) {
  const { rows, columnTotals, grandTotal, maxCell } = useMemo(
    () => buildTradeCostPivot(expenses),
    [expenses],
  );

  // Per-cell expense lists behind the hover previews: `trade|costType` for
  // the body cells, `trade|total` for the row-total cells.
  const expensesByCell = useMemo(() => {
    const map = new Map<string, ExpenseOut[]>();
    const push = (key: string, p: ExpenseOut) => {
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    };
    for (const p of expenses) {
      if (!isPrincipalExpense(p)) continue;
      push(`${p.trade}|${p.costType}`, p);
      push(`${p.trade}|total`, p);
    }
    return map;
  }, [expenses]);

  const isActive = (trade: Trade, costType: PivotCostKey | null) =>
    activeCell?.trade === trade && activeCell.costType === costType;

  // Wrap a cell's trigger element in the hover preview when it has expenses.
  const withPreview = (trigger: ReactElement, key: string) => {
    const cellExpenses = expensesByCell.get(key);
    if (!cellExpenses || cellExpenses.length === 0) return trigger;
    return (
      <PreviewCard>
        <PreviewCardTrigger render={trigger} />
        <PreviewCardContent align="start" side="bottom">
          <CellPreview expenses={cellExpenses} />
        </PreviewCardContent>
      </PreviewCard>
    );
  };

  if (rows.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No expense data." />;
  }

  const columns: readonly PivotCostKey[] = PIVOT_COST_KEYS;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className={headRule}>
            <th className={cn(stickyRowHeaderCard, "px-2 py-2 font-medium")}>
              Trade
            </th>
            {columns.map((key) => (
              <th key={key} className="px-2 py-2 text-right font-medium">
                {capitalize(key)}
              </th>
            ))}
            <th className={cn("px-2 py-2 text-right", totalCell)}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.trade} className={bodyRule}>
              <th
                scope="row"
                className={cn(
                  stickyRowHeaderCard,
                  "px-2 py-2 text-left text-sm font-medium",
                )}
              >
                {TRADE_LABELS[row.trade]}
              </th>
              {columns.map((key) => {
                const value = row.cells[key];
                const bucket = heatBucket(value, maxCell);
                const heat = value === 0 ? emptyCell : HEAT_CLASSES[bucket];
                const label =
                  value !== 0 ? formatCurrency(value, 0) : EMPTY_MARK;
                const title =
                  value !== 0 ? formatCurrency(value, 2) : undefined;

                if (!onCellClick) {
                  const cell = (
                    <td className={cn(cellMono, heat)} title={title}>
                      {label}
                    </td>
                  );
                  return (
                    <Fragment key={key}>
                      {value !== 0
                        ? withPreview(cell, `${row.trade}|${key}`)
                        : cell}
                    </Fragment>
                  );
                }
                return (
                  <td key={key} className="p-0">
                    {withPreview(
                      <button
                        type="button"
                        onClick={() => onCellClick(row.trade, key)}
                        title={title}
                        className={cn(
                          cellMono,
                          heat,
                          interactiveCell,
                          isActive(row.trade, key) && activeCellRing,
                        )}
                      >
                        {label}
                      </button>,
                      `${row.trade}|${key}`,
                    )}
                  </td>
                );
              })}
              {onCellClick ? (
                <td className="p-0">
                  {withPreview(
                    <button
                      type="button"
                      onClick={() => onCellClick(row.trade, null)}
                      className={cn(
                        cellMono,
                        totalCell,
                        interactiveCell,
                        isActive(row.trade, null) && activeCellRing,
                      )}
                    >
                      {formatCurrency(row.total, 0)}
                    </button>,
                    `${row.trade}|total`,
                  )}
                </td>
              ) : (
                withPreview(
                  <td className={cn(cellMono, totalCell)}>
                    {formatCurrency(row.total, 0)}
                  </td>,
                  `${row.trade}|total`,
                )
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={footRule}>
            <th
              className={cn(
                stickyRowHeaderCard,
                "px-2 py-2 text-left font-medium",
              )}
            >
              Total
            </th>
            {columns.map((key) => (
              <td
                key={key}
                className={cn(cellMono, "font-semibold text-primary")}
              >
                {formatCurrency(columnTotals[key], 0)}
              </td>
            ))}
            <td className={cn(cellMono, "font-semibold text-primary")}>
              {formatCurrency(grandTotal, 0)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
