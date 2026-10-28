import type { Entity } from "@cubby/schemas/entity";
import { ArrowsDownUpIcon } from "@phosphor-icons/react/dist/csr/ArrowsDownUp";
import { BookmarkIcon } from "@phosphor-icons/react/dist/csr/Bookmark";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { RowsIcon } from "@phosphor-icons/react/dist/csr/Rows";
import { SortAscendingIcon } from "@phosphor-icons/react/dist/csr/SortAscending";
import { SortDescendingIcon } from "@phosphor-icons/react/dist/csr/SortDescending";
import { useQueryClient } from "@tanstack/react-query";
import type { RowData } from "@tanstack/react-table";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";

import { viewsForEntity } from "~/entity/model/view-manifest";
import { usePageWorkbenchTarget } from "~/entity/page/page";
import { cn } from "~/lib/utils";
import { Row, Toolbar } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuContent,
  DropdownMenuSubmenuTrigger,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

import { isTableLayoutCustomized } from "../../ui/data-table/column-layout";
import { DataTableViewOptions } from "../../ui/data-table/data-table-view-options";
import type { FilterSheetSwitch } from "../../ui/data-table/filter-bar";
import { sortableColumns } from "../../ui/data-table/mobile-sort-sheet";
import type { CubbyTable as Table } from "../../ui/data-table/table-features";
import TableLayoutCustomizer from "../../ui/data-table/table-layout-customizer";
import { mobileColumnLabel } from "../../ui/data-table/table-meta";
import { SavedViewTabs, TableSavedViewsMenuItems } from "./data-table-views";
import { LedgerFilters } from "./ledger-filters";
import { ProblemWorklistStatus } from "./problem-worklist";

interface DataTableToolbarProps<TData extends RowData> {
  table: Table<TData>;
  /** Which entity this table lists — drives the saved-views menu, which
   *  renders nothing for an entity with no declared views. */
  entity?: Entity;
  /** Slot for additional content like summaries (e.g., "Value: $5,845.91") */
  additionalContent?: ReactNode;
  /** Primary actions (e.g., "Create New" button) */
  actions?: ReactNode;
  /** Floating bulk actions, rendered when rows are selected. */
  bulkActionBar?: ReactNode;
  /** Show desktop view options dropdown (column toggles) */
  showViewOptions?: boolean;
  /** Additional className for styling */
  className?: string;
  /** Previous-query rows remain visible while the next first page is loading. */
  isTransitioning?: boolean;
  /** Server-side facet count hints forwarded to the mounted filter controls. */
  filterOptionHints?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /** Hoist the whole query tier into the stable page-workbench band. */
  portalWorkbenchUtilities?: boolean;
  /** CSS gate used while desktop and phone table branches coexist pre-hydration. */
  workbenchUtilityViewport?: "all" | "desktop" | "mobile";
  /** Embedded relationship ledgers keep query tools but omit page-owned views. */
  variant?: "page" | "embedded";
  /**
   * Extra items appended to the page-mode `Actions ▾` menu, after a
   * separator — the caller's inspector toggle and grouped-list toggle, which
   * only `RTable` (the table owner) can construct. Ignored for `embedded`.
   */
  actionsMenuExtra?: ReactNode;
  /**
   * The list's presentation switches (Grouped, Nested) for the phone band,
   * whose Filter sheet carries each as a row. Desktop and embedded tables
   * toggle them beside the table instead.
   */
  switches?: readonly FilterSheetSwitch[] | undefined;
}

function SavedViewsSubmenu<TData extends RowData>({
  table,
  entity,
}: {
  table: Table<TData>;
  entity?: Entity;
}) {
  if (viewsForEntity(useQueryClient(), entity).length === 0) return null;
  return (
    <DropdownMenuSubmenu>
      <DropdownMenuSubmenuTrigger>
        <BookmarkIcon />
        Saved views
        <CaretRightIcon className="ml-auto" />
      </DropdownMenuSubmenuTrigger>
      <DropdownMenuSubmenuContent>
        <TableSavedViewsMenuItems table={table} entity={entity} />
      </DropdownMenuSubmenuContent>
    </DropdownMenuSubmenu>
  );
}

/**
 * The page-mode workbench's `Actions ▾`: table-layout customization and
 * saved views, plus whatever the table owner (`RTable`) folds in through
 * `extra` (inspector/grouped toggles and the list's bulk verbs, disabled at
 * rest). The live selection bar floats below the table, leaving query tools
 * available while rows are selected.
 */
function ActionsMenu<TData extends RowData>({
  table,
  entity,
  showColumns,
  extra,
}: {
  table: Table<TData>;
  entity?: Entity;
  showColumns: boolean;
  extra?: ReactNode;
}) {
  const [columnsOpen, setColumnsOpen] = useState(false);
  const isCustomized = isTableLayoutCustomized(
    table.state,
    table.options.meta?.defaultLayout,
  );
  const hasViews = viewsForEntity(useQueryClient(), entity).length > 0;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="relative h-7.5 shrink-0 text-sm"
            />
          }
        >
          Actions
          <CaretDownIcon />
          {isCustomized && (
            <span
              aria-hidden
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {showColumns && (
            <DropdownMenuItem onClick={() => setColumnsOpen(true)}>
              <GearSixIcon />
              Columns…
            </DropdownMenuItem>
          )}
          {hasViews && <SavedViewsSubmenu table={table} entity={entity} />}
          {extra && (
            <>
              <DropdownMenuSeparator />
              {extra}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {showColumns && (
        <Overlay
          open={columnsOpen}
          onOpenChange={setColumnsOpen}
          title="Columns"
        >
          <TableLayoutCustomizer table={table} />
        </Overlay>
      )}
    </>
  );
}

/**
 * The list's sort as one menu: "Sort by" over the sortable columns, then
 * "Order". Writes the same `sorting` state the column headers do; a cleared
 * sort falls back to the entity's declared default order.
 */
function SortMenu<TData extends RowData>({ table }: { table: Table<TData> }) {
  const columns = sortableColumns(table);
  if (columns.length === 0) return null;
  const [active] = table.state.sorting;
  const activeColumn = columns.find((column) => column.id === active?.id);
  const label = activeColumn ? mobileColumnLabel(activeColumn) : "Default";
  const date = activeColumn?.columnDef.meta?.valueKind === "date";
  const OrderIcon = active?.desc ? SortDescendingIcon : SortAscendingIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={`Sort: ${label}${active ? (active.desc ? ", descending" : ", ascending") : ""}`}
            className="h-7.5 shrink-0 text-sm"
          />
        }
      >
        {active ? (
          <OrderIcon className="size-3.5" />
        ) : (
          <ArrowsDownUpIcon className="size-3.5" />
        )}
        {label}
        {active
          ? ` · ${date ? (active.desc ? "newest" : "oldest") : active.desc ? "descending" : "ascending"}`
          : ""}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup aria-label="Sort by">
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          <DropdownMenuItem
            aria-current={active ? undefined : "true"}
            onClick={() => table.setSorting([])}
          >
            Default
            {!active && <CheckIcon className="ml-auto size-3.5" />}
          </DropdownMenuItem>
          {columns.map((column) => {
            const current = column.id === active?.id;
            return (
              <DropdownMenuItem
                key={column.id}
                aria-current={current ? "true" : undefined}
                onClick={() =>
                  table.setSorting([
                    {
                      id: column.id,
                      desc: current
                        ? active.desc
                        : column.getFirstSortDir() === "desc",
                    },
                  ])
                }
              >
                {mobileColumnLabel(column)}
                {current && <CheckIcon className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        {active && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup aria-label="Order">
              <DropdownMenuLabel>Order</DropdownMenuLabel>
              {(
                [
                  [false, "Ascending", SortAscendingIcon],
                  [true, "Descending", SortDescendingIcon],
                ] as const
              ).map(([desc, text, Icon]) => (
                <DropdownMenuItem
                  key={text}
                  aria-current={active.desc === desc ? "true" : undefined}
                  onClick={() => table.setSorting([{ id: active.id, desc }])}
                >
                  <Icon className="size-3.5" />
                  {text}
                  {active.desc === desc && (
                    <CheckIcon className="ml-auto size-3.5" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Group by over the table meta's choices; absent when it offers none. */
export function GroupMenu<TData extends RowData>({
  table,
}: {
  table: Table<TData>;
}) {
  const grouping = table.options.meta?.grouping;
  if (!grouping?.choices.length) return null;
  const active = grouping.choices.find(
    (choice) => choice.key === grouping.active,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-7.5 text-sm"
            aria-label={`Group: ${active?.label ?? "None"}`}
          />
        }
      >
        <RowsIcon className="size-3.5" />
        {active?.label ?? "Group"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => grouping.onChange(null)}>
          No grouping{!active && <CheckIcon className="ml-auto size-3.5" />}
        </DropdownMenuItem>
        {grouping.choices.map((choice) => (
          <DropdownMenuItem
            key={choice.key}
            disabled={Boolean(choice.reason)}
            onClick={() => grouping.onChange(choice.key)}
          >
            <span>
              {choice.label}
              {choice.reason && (
                <span className="block text-xs text-muted-foreground">
                  {choice.reason}
                </span>
              )}
            </span>
            {active === choice && <CheckIcon className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The query tier: bulk slot plus the rest (problem status, filters,
 * `Actions ▾`, page actions) as ONE node — so `styles.css`'s
 * `:has([data-bulk-action-bar])` rule keeps swapping the whole tier for the
 * bulk bar regardless of whether this renders in place or portaled. Split out
 * of `DataTableToolbar` to keep that function's branching under the
 * complexity ceiling; behaviour is unchanged.
 */
function QueryTierFieldset<TData extends RowData>({
  table,
  entity,
  isTransitioning,
  isPage,
  isMobileFilterTier,
  problemStatus,
  additionalContent,
  filterOptionHints,
  showViewOptions,
  actionsMenuExtra,
  bulkActionBar,
  actions,
  switches,
}: {
  table: Table<TData>;
  entity?: Entity;
  isTransitioning: boolean;
  isPage: boolean;
  isMobileFilterTier: boolean;
  problemStatus: ReactNode;
  additionalContent?: ReactNode;
  filterOptionHints?: DataTableToolbarProps<TData>["filterOptionHints"];
  showViewOptions: boolean;
  actionsMenuExtra?: ReactNode;
  bulkActionBar?: ReactNode;
  actions?: ReactNode;
  switches?: readonly FilterSheetSwitch[] | undefined;
}) {
  const actionsTarget = usePageWorkbenchTarget("actions");
  const tabsTarget = usePageWorkbenchTarget("tabs", isPage);
  const menu =
    isPage && !isMobileFilterTier ? (
      <fieldset
        disabled={isTransitioning}
        className={actionsTarget ? "hidden md:block" : undefined}
      >
        <ActionsMenu
          table={table}
          entity={entity}
          showColumns={showViewOptions}
          extra={actionsMenuExtra}
        />
      </fieldset>
    ) : null;
  return (
    <fieldset disabled={isTransitioning} className="contents">
      <div data-query-bulk className="contents">
        {bulkActionBar}
      </div>
      <Row
        data-query-rest
        align="center"
        justify="end"
        gap="sm"
        wrap
        className={isPage ? "min-w-0 flex-1" : undefined}
      >
        {isPage && problemStatus}
        {additionalContent}
        <div className="min-w-0 flex-1">
          <LedgerFilters
            table={table}
            entity={entity}
            workbench={isPage}
            optionHints={filterOptionHints}
            variant={isMobileFilterTier ? "mobile" : "desktop"}
            switches={isMobileFilterTier ? switches : undefined}
          />
        </div>
        {isPage && !isMobileFilterTier && <SortMenu table={table} />}
        {!isPage && !isMobileFilterTier && <GroupMenu table={table} />}
        {isPage && !isMobileFilterTier && tabsTarget
          ? createPortal(
              <SavedViewTabs table={table} entity={entity} />,
              tabsTarget,
            )
          : null}
        {actionsTarget ? createPortal(menu, actionsTarget) : menu}
        {actions}
      </Row>
    </fieldset>
  );
}

export function DataTableToolbar<TData extends RowData>({
  table,
  entity,
  additionalContent,
  actions,
  bulkActionBar,
  showViewOptions = true,
  className,
  isTransitioning = false,
  filterOptionHints,
  portalWorkbenchUtilities = false,
  workbenchUtilityViewport = "all",
  variant = "page",
  actionsMenuExtra,
  switches,
}: DataTableToolbarProps<TData>) {
  const workbenchTarget = usePageWorkbenchTarget();
  const isPage = variant === "page";
  const shouldPortal = portalWorkbenchUtilities && workbenchTarget !== null;

  const problemStatus = entity && (
    <ProblemWorklistStatus
      entity={entity}
      filters={table.state.columnFilters}
      sorting={table.state.sorting}
    />
  );
  // Embedded keeps its own compact "Columns" trigger to the left of the query
  // tier — page-mode folds the equivalent control into `Actions ▾` instead.
  const embeddedUtilities = !isPage && showViewOptions && (
    <DataTableViewOptions table={table} />
  );
  // The phone band's `Filter` sheet carries its own "Columns" footer entry
  // (`MobileFilterTier`), so `Actions ▾` on a page-mode phone omits it —
  // otherwise the same control would live in two places.
  const isMobileFilterTier = isPage && workbenchUtilityViewport === "mobile";

  const fieldset = (
    <QueryTierFieldset
      table={table}
      entity={entity}
      isTransitioning={isTransitioning}
      isPage={isPage}
      isMobileFilterTier={isMobileFilterTier}
      problemStatus={problemStatus}
      additionalContent={additionalContent}
      filterOptionHints={filterOptionHints}
      showViewOptions={showViewOptions}
      actionsMenuExtra={actionsMenuExtra}
      bulkActionBar={bulkActionBar}
      actions={actions}
      switches={switches}
    />
  );

  if (shouldPortal) {
    const utilityClass =
      workbenchUtilityViewport === "desktop"
        ? "hidden md:contents"
        : workbenchUtilityViewport === "mobile"
          ? "contents md:hidden"
          : "contents";
    return createPortal(
      <div className={utilityClass}>{fieldset}</div>,
      workbenchTarget,
    );
  }

  return (
    <Toolbar
      label="Table tools"
      data-toolbar-variant={variant}
      className={cn(
        "flex min-w-0 flex-wrap items-center bg-card px-2 py-1 [&>div]:w-full [&>div>div:last-child]:flex-1",
        variant === "embedded" ? "min-h-8 gap-1" : "min-h-10 gap-2",
        className,
      )}
      start={
        !isPage && (
          <Row align="center" gap="xs" className="shrink-0">
            {problemStatus}
            {embeddedUtilities}
          </Row>
        )
      }
      end={<div className="min-w-0 flex-1">{fieldset}</div>}
    />
  );
}
