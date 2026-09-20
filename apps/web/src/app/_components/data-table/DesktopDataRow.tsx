import { parseShortcode } from "@cubby/shared";
import type { RowData } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import { Bug } from "lucide-react";
import {
  type FocusEvent,
  type MouseEvent,
  memo,
  type PointerEvent,
  type ReactNode,
} from "react";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import { TableCell, TableRow } from "~/components/ui/table";
import { isInspectableFieldProvenance } from "~/entities/field-provenance";
import { cn } from "~/lib/utils";

import { NON_SELECTABLE_COLUMN_IDS } from "./cell-selection-context";
import { columnWidthValue } from "./column-layout";
import { DebugDialog } from "./DebugDialog";
import { RelationFieldWorkbench } from "./relation-field-workbench";
import type { CubbyRow as Row } from "./table-features";
import type { CubbyColumnMeta } from "./table-meta";

const NUMERIC_CELL = "text-right font-mono tabular-nums";
const MONO_CELL = "font-mono";
const dataRowIdentitySchema = z.object({ id: z.string() });

function relationWorkbenchContent(
  row: RowData,
  rendered: ReactNode,
  meta: CubbyColumnMeta | undefined,
): ReactNode {
  const provenance = meta?.provenance;
  if (
    meta?.mobile?.slot === "image" ||
    meta?.provenanceWorkbenchHandled ||
    !isInspectableFieldProvenance(provenance)
  ) {
    return rendered;
  }
  const rowIdentity = dataRowIdentitySchema.safeParse(row);
  if (!rowIdentity.success) return rendered;
  const parsed = parseShortcode(rowIdentity.data.id);
  if (!parsed) return rendered;
  return (
    <RelationFieldWorkbench
      sourceEntity={parsed.type}
      sourceId={parsed.shortcode}
      provenance={provenance}
      summary={rendered}
    />
  );
}

function cellPresentation<TItem extends RowData>(
  cell: ReturnType<Row<TItem>["getVisibleCells"]>[number],
) {
  const selectable =
    cell.getCanSelect() && !NON_SELECTABLE_COLUMN_IDS.has(cell.column.id);
  const selected = selectable && cell.getIsSelected();
  const anchor = selected && cell.getIsFocused();
  const pinned = cell.column.getIsPinned();
  const columns =
    pinned === "start"
      ? cell.getContext().table.getStartVisibleLeafColumns()
      : pinned === "end"
        ? cell.getContext().table.getEndVisibleLeafColumns()
        : [];
  const index = columns.findIndex((column) => column.id === cell.column.id);
  const boundary =
    pinned === "start" && index === columns.length - 1
      ? "border-r-2 border-r-foreground"
      : pinned === "end" && index === 0
        ? "border-l-2 border-l-foreground"
        : undefined;
  const width = columnWidthValue(cell.column.id);
  return { selectable, selected, anchor, pinned, boundary, width };
}

function DesktopDataCell<TItem extends RowData>({
  cell,
  cellClassName,
}: {
  cell: ReturnType<Row<TItem>["getVisibleCells"]>[number];
  cellClassName: string;
}) {
  const presentation = cellPresentation(cell);
  const { selectable, selected, anchor, pinned, boundary, width } =
    presentation;
  const inset =
    pinned === "start"
      ? { insetInlineStart: cell.column.getStart("start") }
      : pinned === "end"
        ? { insetInlineEnd: cell.column.getAfter("end") }
        : {};
  const rendered = flexRender(cell.column.columnDef.cell, cell.getContext());
  const content = relationWorkbenchContent(
    cell.row.original,
    rendered,
    cell.column.columnDef.meta,
  );
  return (
    <TableCell
      key={cell.id}
      data-cell-col={selectable ? cell.column.id : undefined}
      data-cell-selected={selected ? "" : undefined}
      data-cell-anchor={anchor ? "" : undefined}
      tabIndex={selectable ? cell.getTabIndex() : undefined}
      onMouseDown={selectable ? cell.getSelectionStartHandler() : undefined}
      onMouseEnter={selectable ? cell.getSelectionExtendHandler() : undefined}
      className={cn(
        cellClassName,
        cell.column.columnDef.meta?.numeric && NUMERIC_CELL,
        cell.column.columnDef.meta?.mono && MONO_CELL,
        cell.column.columnDef.meta?.className,
        selected && "bg-primary/10",
        anchor && "ring-2 ring-ring ring-inset",
        pinned && "sticky z-10 bg-background",
        boundary,
      )}
      style={{ width, minWidth: width, maxWidth: width, ...inset }}
    >
      {content}
    </TableCell>
  );
}

export interface DesktopDataRowProps<TItem extends RowData> {
  row: Row<TItem>;
  /**
   * Flat index of this row within the controller's `rows` array — the
   * coordinate space cell selection uses (may differ from `row.index` under
   * grouping/expansion). Tags the `<tr>` with `data-cell-row` and is compared
   * against the selection's focus row.
   */
  rowIndex: number;
  isSelected: boolean;
  /** Current record shown by a desktop inspector; independent of bulk selection. */
  isCurrent: boolean;
  /**
   * Snapshot of `row.getIsExpanded()` taken at parent render time (same
   * pattern as `isSelected`). Exists purely for the memo compare — calling
   * `getIsExpanded()` inside `rowPropsAreEqual` is useless because it's a live
   * read of CURRENT table state, so previous vs next always match.
   */
  isExpanded: boolean;
  isFocused: boolean;
  isDebugEnabled: boolean;
  onRowClick?: (row: Row<TItem>) => void;
  onRowHover?: (row: Row<TItem>) => void;
  onRowHoverEnd?: (row: Row<TItem>) => void;
  rowClassName: string;
  cellClassName: string;
  columnsKey: string;
  /** External cell-render state snapshot; see useTableConfig. */
  rowContentVersion?: unknown;
  /** Per-row native cell-selection projection from table.Subscribe. */
  selectionVersion?: string;
  height?: string;
  /**
   * When true (cell-selection tables), a click landing on an editable cell
   * selects rather than firing the row's onClick — the row-nav/preview open
   * moves to Cmd/Ctrl+Enter. Off for embedded/other uses.
   */
  suppressCellRowClick?: boolean;
}

function isInteractiveEventTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    target.closest(
      "a, button, input, select, textarea, [role=button], [role=link]",
    ) !== null
  );
}

function DesktopDataRowInner<TItem extends RowData>({
  row,
  rowIndex,
  isSelected,
  isCurrent,
  isFocused,
  isDebugEnabled,
  onRowClick,
  onRowHover,
  onRowHoverEnd,
  rowClassName,
  cellClassName,
  height,
  suppressCellRowClick,
}: DesktopDataRowProps<TItem>) {
  const handleRowClick = onRowClick
    ? (e: MouseEvent<HTMLTableRowElement>) => {
        if (isInteractiveEventTarget(e.target)) return;

        // In cell-selection mode a click on an editable cell selects it (via the
        // container's mousedown delegation); don't also navigate/open the row.
        if (suppressCellRowClick) {
          const td =
            e.target instanceof HTMLElement
              ? e.target.closest("td[data-cell-col]")
              : null;
          if (td?.querySelector("[data-cell-edit-trigger]")) return;
        }
        onRowClick(row);
      }
    : undefined;

  return (
    <TableRow
      data-cell-row={rowIndex}
      data-state={isSelected && "selected"}
      data-current={isCurrent ? "true" : undefined}
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        rowClassName,
        onRowClick && "cursor-pointer",
        isFocused && "ring-2 ring-primary/30 ring-inset",
        // Current record is presentation state for the inspector, not TanStack
        // row selection. Keep the two attributes separate so bulk actions and
        // row-selection semantics never change when inspection changes.
        isCurrent &&
          "bg-primary/[0.035] [&>td:first-child]:shadow-[inset_2px_0_0_var(--row-accent,var(--primary))]",
      )}
      onClick={handleRowClick}
      onPointerEnter={
        onRowHover
          ? (event: PointerEvent<HTMLTableRowElement>) => {
              if (
                event.pointerType !== "touch" &&
                !isInteractiveEventTarget(event.target)
              ) {
                onRowHover(row);
              }
            }
          : undefined
      }
      onPointerLeave={
        onRowHoverEnd
          ? (event: PointerEvent<HTMLTableRowElement>) => {
              if (event.pointerType !== "touch") onRowHoverEnd(row);
            }
          : undefined
      }
      onFocus={
        onRowHover
          ? (event) => {
              if (!isInteractiveEventTarget(event.target)) onRowHover(row);
            }
          : undefined
      }
      onBlur={
        onRowHoverEnd
          ? (event: FocusEvent<HTMLTableRowElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                onRowHoverEnd(row);
              }
            }
          : undefined
      }
      style={height ? { height } : undefined}
    >
      {[
        ...row.getStartVisibleCells(),
        ...row.getCenterVisibleCells(),
        ...row.getEndVisibleCells(),
      ].map((cell) => (
        <DesktopDataCell
          key={cell.id}
          cell={cell}
          cellClassName={cellClassName}
        />
      ))}
      {isDebugEnabled && (
        <TableCell className={cellClassName}>
          <DebugDialog
            data={row.original}
            title={`Debug Data - Row ${row.id}`}
            trigger={
              <Button variant="ghost" size="icon-sm">
                <Bug className="size-4" />
                <span className="sr-only">Debug row data</span>
              </Button>
            }
          />
        </TableCell>
      )}
      <TableCell data-spacer aria-hidden className={cellClassName} />
    </TableRow>
  );
}

function rowPropsAreEqual<TItem extends RowData>(
  previous: DesktopDataRowProps<TItem>,
  next: DesktopDataRowProps<TItem>,
): boolean {
  return (
    previous.row.original === next.row.original &&
    // Always-equal (false===false) for non-tree tables, so this is inert there;
    // required so a toggled parent's chevron re-renders when its expanded state
    // flips (row.original is unchanged by an expand/collapse). Compares the
    // render-time snapshot prop — see the isExpanded doc comment.
    previous.isExpanded === next.isExpanded &&
    previous.isSelected === next.isSelected &&
    previous.isCurrent === next.isCurrent &&
    previous.isFocused === next.isFocused &&
    previous.isDebugEnabled === next.isDebugEnabled &&
    previous.onRowClick === next.onRowClick &&
    previous.onRowHover === next.onRowHover &&
    previous.onRowHoverEnd === next.onRowHoverEnd &&
    previous.rowClassName === next.rowClassName &&
    previous.cellClassName === next.cellClassName &&
    previous.columnsKey === next.columnsKey &&
    Object.is(previous.rowContentVersion, next.rowContentVersion) &&
    previous.selectionVersion === next.selectionVersion &&
    previous.height === next.height &&
    previous.rowIndex === next.rowIndex &&
    previous.suppressCellRowClick === next.suppressCellRowClick
  );
}

const memoizedDesktopDataRow = memo(DesktopDataRowInner, rowPropsAreEqual);
export const DesktopDataRow =
  // SAFETY: React.memo preserves DesktopDataRowInner's generic props at this
  // boundary; the comparator compares the complete generic prop set.
  memoizedDesktopDataRow as typeof DesktopDataRowInner;
