import type { RowData } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Check } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Eyebrow } from "~/components/ui/eyebrow";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import type {
  CubbyColumn as Column,
  CubbyTable as ITable,
} from "./table-features";
import { mobileColumnLabel } from "./useMobileListModel";

/**
 * Whether `ref`'s element straddles the vertical middle of the viewport.
 *
 * The sort control is anchored to the bottom of the screen (thumb reach), and
 * a page can stack several lists — the projects dashboard renders three. A
 * plain fixed button would therefore stack three of itself. Collapsing the
 * observer root to a zero-height line at the viewport's midpoint makes the
 * answer exclusive: at most one list contains that line, so at most one sort
 * control is on screen, and it belongs to the list the user is actually
 * looking at.
 */
function useOwnsViewportMidline(ref: RefObject<HTMLElement | null>): boolean {
  const [owns, setOwns] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setOwns(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "-50% 0px -50% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return owns;
}

/** The columns a phone may sort by — the same set the desktop headers expose. */
function sortableColumns<TItem extends RowData>(
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
 * The phone's sort control: a thumb-zone trigger plus a bottom sheet.
 *
 * Sorting otherwise lives on desktop column headers, and mobile cards have no
 * headers — so "what did I buy most recently" was a desktop-only question. It
 * drives the SAME `sorting` table state the headers do (read from
 * `table.state`, written through `table.setSorting`), so the URL
 * round-trip, the server query, and the desktop headers stay one source of
 * truth rather than two that drift.
 *
 * Single-sort by design: the desktop's shift-click stack has no phone gesture,
 * and picking a column here replaces the stack rather than silently editing an
 * invisible one.
 */
export function MobileSortSheet<TItem extends RowData>({
  table,
  listRef,
  disabled = false,
}: {
  table: ITable<TItem>;
  /** The list region this control belongs to — see `useOwnsViewportMidline`. */
  listRef: RefObject<HTMLElement | null>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const onScreen = useOwnsViewportMidline(listRef);
  // Derived per render rather than memoized: TanStack already memoizes the
  // column lookups behind it, and the inputs (sorting, column visibility) live
  // on a table instance whose identity never changes — so a dependency array
  // here would be a lie.
  const columns = sortableColumns(table);

  const [activeSort] = table.state.sorting;
  const activeDesc = activeSort?.desc ?? false;
  const activeColumn = activeSort
    ? columns.find((column) => column.id === activeSort.id)
    : undefined;
  const activeLabel = activeColumn
    ? mobileColumnLabel(activeColumn)
    : "Default";

  if (columns.length === 0) return null;

  return (
    <>
      {onScreen && !disabled && (
        <div
          data-mobile-sort-trigger
          // Clears the fixed bottom nav (a 3.5rem bar plus its safe-area pad)
          // so the control sits in the thumb zone without covering navigation.
          className="fixed right-2 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] z-40 md:hidden print:hidden"
        >
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            className="h-11 gap-1 px-2 font-mono text-2xs tracking-wider uppercase"
            aria-label={`Sort — currently ${activeLabel}`}
          >
            <ArrowUpDown className="size-3.5" />
            <span className="max-w-24 truncate">{activeLabel}</span>
            {activeSort ? (
              activeDesc ? (
                <ArrowDown className="size-3.5" />
              ) : (
                <ArrowUp className="size-3.5" />
              )
            ) : null}
          </Button>
        </div>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="flex max-h-[70vh] flex-col rounded-none"
        >
          <SheetHeader className="border-b border-[var(--border)] p-4">
            <SheetTitle>Sort</SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
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
                  direction={
                    selected ? (activeDesc ? "desc" : "asc") : undefined
                  }
                  onSelect={() =>
                    table.setSorting([
                      {
                        id: column.id,
                        // Re-tapping the current column flips it; a fresh
                        // column opens in whatever direction it reads best in
                        // (dates and money descend, names ascend).
                        desc: selected
                          ? !activeDesc
                          : column.getFirstSortDir() === "desc",
                      },
                    ])
                  }
                />
              );
            })}
          </div>

          <Row
            gap="sm"
            className="safe-bottom border-t border-[var(--border)] p-4"
          >
            <Button
              variant="outline"
              className="h-11 flex-1"
              onClick={() => table.setSorting([])}
              disabled={!activeSort}
            >
              Reset to default
            </Button>
            <Button className="h-11 flex-1" onClick={() => setOpen(false)}>
              Done
            </Button>
          </Row>
        </SheetContent>
      </Sheet>
    </>
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
        {direction === "asc" && <ArrowUp className="size-3.5" />}
        {direction === "desc" && <ArrowDown className="size-3.5" />}
        {selected && <Check className="size-3.5" />}
      </Row>
    </Row>
  );
}
