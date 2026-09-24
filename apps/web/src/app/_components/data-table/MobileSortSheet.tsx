import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import type { RowData } from "@tanstack/react-table";

import { Row, Stack } from "~/components/layout";
import { Eyebrow } from "~/components/ui/eyebrow";
import { cn } from "~/lib/utils";

import type {
  CubbyColumn as Column,
  CubbyTable as ITable,
} from "./table-features";
import { mobileColumnLabel } from "./useMobileListModel";

/** The columns a phone may sort by — the same set the desktop headers expose. */
export function sortableColumns<TItem extends RowData>(
  table: ITable<TItem>,
): Column<TItem, unknown>[] {
  const visible = table
    .getVisibleLeafColumns()
    .filter((column) => column.getCanSort());
  // A sort can outlive the column that set it (a saved view, a shared link, a
  // hidden column). Append it rather than hiding it: the sheet has to be able
  // to show — and undo — the sort the list is actually in.
  const activeId = table.state.sorting[0]?.id;
  if (!activeId || visible.some((column) => column.id === activeId)) {
    return visible;
  }
  const active = table.getColumn(activeId);
  return active ? [...visible, active] : visible;
}

/**
 * The phone Filter sheet's "Sort" section: the same `sorting` table state the
 * desktop column headers drive (read from `table.state`, written through
 * `table.setSorting`), so the URL round-trip, the server query, and the
 * desktop headers stay one source of truth rather than two that drift.
 *
 * Single-sort by design: the desktop's shift-click stack has no phone
 * gesture, and picking a column here replaces the stack rather than silently
 * editing an invisible one.
 */
export function SortSection<TItem extends RowData>({
  table,
}: {
  table: ITable<TItem>;
}) {
  const columns = sortableColumns(table);
  if (columns.length === 0) return null;

  const [activeSort] = table.state.sorting;
  const activeDesc = activeSort?.desc ?? false;

  return (
    <Stack gap="tight">
      <Eyebrow as="div" className="px-4 pt-3 pb-1">
        Sort
      </Eyebrow>
      <SortOption
        label="Default"
        // Cleared sort is not "unsorted" — the list falls back to the
        // entity's own default order (see `buildSortsParams`), which is
        // exactly what "reset" should mean here.
        detail="Newest first"
        selected={!activeSort}
        onSelect={() => table.setSorting([])}
      />
      {columns.map((column) => {
        const selected = activeSort?.id === column.id;
        return (
          <SortOption
            key={column.id}
            label={mobileColumnLabel(column)}
            selected={selected}
            direction={selected ? (activeDesc ? "desc" : "asc") : undefined}
            onSelect={() =>
              table.setSorting([
                {
                  id: column.id,
                  // Re-tapping the current column flips it; a fresh column
                  // opens in whatever direction it reads best in (dates and
                  // money descend, names ascend).
                  desc: selected
                    ? !activeDesc
                    : column.getFirstSortDir() === "desc",
                },
              ])
            }
          />
        );
      })}
    </Stack>
  );
}

/**
 * One row of the sheet. 48px so the whole list is thumb-navigable, and the
 * direction arrow rides on the selected row rather than in a separate
 * asc/desc control — one tap changes the sort, a second reverses it.
 */
function SortOption({
  label,
  detail,
  selected,
  direction,
  onSelect,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  direction?: "asc" | "desc";
  onSelect: () => void;
}) {
  return (
    <Row
      as="button"
      type="button"
      align="center"
      gap="sm"
      justify="between"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "min-h-12 w-full border-b border-[var(--border)] px-4 text-left transition-colors active:bg-muted/60",
        selected && "text-primary",
      )}
    >
      {/* `as="span"`: a <button>'s content model is phrasing content, and the
          primitives default to <div>. */}
      <Stack as="span" gap="tight" className="min-w-0">
        <span className="truncate font-mono text-xs tracking-wider uppercase">
          {label}
        </span>
        {detail && (
          <Eyebrow as="span" className="truncate">
            {detail}
          </Eyebrow>
        )}
      </Stack>
      <Row as="span" align="center" gap="xs" className="shrink-0">
        {direction === "asc" && <ArrowUpIcon className="size-3.5" />}
        {direction === "desc" && <ArrowDownIcon className="size-3.5" />}
        {selected && <CheckIcon className="size-3.5" />}
      </Row>
    </Row>
  );
}
