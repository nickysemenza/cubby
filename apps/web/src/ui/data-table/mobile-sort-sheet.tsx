import type { GeneratedListFieldPresentation } from "@cubby/schemas/entity-projection-types";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import type { RowData } from "@tanstack/react-table";
import { cn } from "cn";
import type { ReactNode } from "react";

import { Row, Stack } from "~/ui/layout";
import { Eyebrow } from "~/ui/text/eyebrow";

import { ColumnEntityMark, ListFieldTypeMark } from "./column-presentation";
import type { CubbyTable as ITable } from "./table-features";
import { mobileColumnLabel } from "./table-meta";

/** Sort eligibility is independent of whether the member shows the column. */
export function sortableFields<TItem extends RowData>(
  table: ITable<TItem>,
): {
  id: string;
  label: string;
  presentation: GeneratedListFieldPresentation | undefined;
  desc: boolean;
}[] {
  if (table.options.enableSorting === false) return [];
  const columns = table.getAllLeafColumns();
  const declared = table.options.meta?.sortFields;
  if (declared && table.options.manualSorting)
    return declared.map(({ key, presentation }) => {
      const column = columns.find((column) => column.id === key);
      return {
        id: key,
        label: presentation.label,
        presentation,
        desc: column
          ? column.getFirstSortDir() === "desc"
          : ["number", "money", "date", "count"].includes(
              presentation.valueType,
            ),
      };
    });
  return columns
    .filter((column) => column.getCanSort())
    .map((column) => ({
      id: column.id,
      label:
        column.columnDef.meta?.presentation?.label ?? mobileColumnLabel(column),
      presentation: column.columnDef.meta?.presentation,
      desc: column.getFirstSortDir() === "desc",
    }));
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
  const columns = sortableFields(table);
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
        detail="Declared default order"
        selected={!activeSort}
        onSelect={() => table.setSorting([])}
      />
      {columns.map((column) => {
        const selected = activeSort?.id === column.id;
        return (
          <SortOption
            key={column.id}
            label={column.label}
            mark={
              column.presentation?.target ? (
                <ColumnEntityMark
                  meta={{ presentation: column.presentation }}
                />
              ) : (
                <ListFieldTypeMark
                  valueType={column.presentation?.valueType ?? "text"}
                />
              )
            }
            detail={
              column.presentation?.sort.supported
                ? (column.presentation.sort.description ?? undefined)
                : undefined
            }
            selected={selected}
            direction={selected ? (activeDesc ? "desc" : "asc") : undefined}
            onSelect={() =>
              table.setSorting([
                {
                  id: column.id,
                  // Re-tapping the current column flips it; a fresh column
                  // opens in whatever direction it reads best in (dates and
                  // money descend, names ascend).
                  desc: selected ? !activeDesc : column.desc,
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
  mark,
  detail,
  selected,
  direction,
  onSelect,
}: {
  label: string;
  mark?: ReactNode;
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
      aria-label={`Sort by ${label}`}
      className={cn(
        "min-h-12 w-full border-b border-[var(--border)] px-4 text-left transition-colors active:bg-muted/60",
        selected && "text-primary",
      )}
    >
      {mark}
      {/* `as="span"`: a <button>'s content model is phrasing content, and the
          primitives default to <div>. */}
      <Stack as="span" gap="tight" className="min-w-0">
        <span className="truncate text-xs font-medium">{label}</span>
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
