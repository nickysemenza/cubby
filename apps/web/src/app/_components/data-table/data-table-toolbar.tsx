import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { Entity } from "@cubby/schemas/entity";
import { BookmarkIcon as Bookmark } from "@phosphor-icons/react/dist/csr/Bookmark";
import { CaretDownIcon as ChevronDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { GearSixIcon as Settings2 } from "@phosphor-icons/react/dist/csr/GearSix";
import type { RowData } from "@tanstack/react-table";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";

import { Row } from "~/components/layout";
import { usePageWorkbenchTarget } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { Spinner } from "~/components/ui/spinner";
import { viewsForEntity } from "~/entities/view-manifest";
import { cn } from "~/lib/utils";

import { isTableLayoutCustomized } from "./column-layout";
import { DataTableViewOptions } from "./data-table-view-options";
import { TableSavedViewsMenuItems } from "./DataTableViews";
import { LedgerFilters } from "./LedgerFilters";
import { ProblemWorklistStatus } from "./problem-worklist";
import type { CubbyTable as Table } from "./table-features";
import TableLayoutCustomizer from "./TableLayoutCustomizer";

interface DataTableToolbarProps<TData extends RowData> {
  table: Table<TData>;
  /** Which entity this table lists — drives the saved-views menu, which
   *  renders nothing for an entity with no declared views. */
  entity?: Entity;
  /** Slot for additional content like summaries (e.g., "Value: $5,845.91") */
  additionalContent?: ReactNode;
  /** Primary actions (e.g., "Create New" button) */
  actions?: ReactNode;
  /** Bulk action bar (rendered when rows selected, replaces view options) */
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
}

/**
 * Visually matches `DropdownMenuItem`/`DropdownMenuContent`
 * (`~/components/ui/dropdown-menu.tsx`) but is hand-built here rather than
 * imported: that file has no submenu primitive, and Lane A does not own it
 * (only its `DropdownMenuLabel` region is spoken for). These classes are
 * copy-once, not a fork to maintain — the underlying `@base-ui/react/menu`
 * primitives are the same ones the shared component wraps.
 */
const submenuTriggerClass =
  "focus:bg-accent focus:text-accent-foreground relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs/relaxed outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";
const submenuContentClass =
  "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 border-[var(--border)] bg-popover text-popover-foreground z-50 max-h-(--available-height) w-(--anchor-width) min-w-56 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border p-1 shadow-[var(--shadow-overlay)] duration-150 outline-none data-closed:overflow-hidden";

function SavedViewsSubmenu<TData extends RowData>({
  table,
  entity,
}: {
  table: Table<TData>;
  entity?: Entity;
}) {
  if (viewsForEntity(entity).length === 0) return null;
  return (
    <MenuPrimitive.SubmenuRoot>
      <MenuPrimitive.SubmenuTrigger className={submenuTriggerClass}>
        <Bookmark />
        Saved views
        <ChevronRight className="ml-auto" />
      </MenuPrimitive.SubmenuTrigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          className="isolate z-50 outline-none"
          side="right"
          align="start"
          sideOffset={2}
        >
          <MenuPrimitive.Popup className={submenuContentClass}>
            <TableSavedViewsMenuItems table={table} entity={entity} />
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.SubmenuRoot>
  );
}

/**
 * The page-mode workbench's `Actions ▾`: table-layout customization and
 * saved views, plus whatever the table owner (`RTable`) needs to fold in
 * (inspector/grouped toggles). Bulk verbs are NOT listed here yet — that
 * needs `useListBulkActions`'s raw `BulkActionsConfig` threaded down from
 * outside this lane's files; the live `bulkActionBar` still replaces this
 * entire tier via `data-query-bulk`/`data-query-rest` (styles.css) once rows
 * are selected, so the real verbs stay reachable in the meantime.
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
    {
      columnOrder: table.state.columnOrder,
      columnPinning: table.state.columnPinning,
      columnVisibility: table.state.columnVisibility,
      columnSizing: table.state.columnSizing,
    },
    table.options.meta?.defaultLayout,
  );
  const hasViews = viewsForEntity(entity).length > 0;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="relative shrink-0" />
          }
        >
          Actions
          <ChevronDown />
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
              <Settings2 />
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
        <ResponsiveDialog
          open={columnsOpen}
          onOpenChange={setColumnsOpen}
          title="Columns"
        >
          <TableLayoutCustomizer table={table} />
        </ResponsiveDialog>
      )}
    </>
  );
}

/**
 * The query tier: bulk slot plus the rest (problem status, spinner, filters,
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
  spinner,
  additionalContent,
  filterOptionHints,
  showViewOptions,
  actionsMenuExtra,
  bulkActionBar,
  actions,
}: {
  table: Table<TData>;
  entity?: Entity;
  isTransitioning: boolean;
  isPage: boolean;
  isMobileFilterTier: boolean;
  problemStatus: ReactNode;
  spinner: ReactNode;
  additionalContent?: ReactNode;
  filterOptionHints?: DataTableToolbarProps<TData>["filterOptionHints"];
  showViewOptions: boolean;
  actionsMenuExtra?: ReactNode;
  bulkActionBar?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <fieldset
      disabled={isTransitioning}
      className="data-table-query-tier contents"
    >
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
        {isPage && spinner}
        {additionalContent}
        <div className="min-w-0 flex-1">
          <LedgerFilters
            table={table}
            entity={entity}
            optionHints={filterOptionHints}
            variant={isMobileFilterTier ? "mobile" : "desktop"}
          />
        </div>
        {/* The phone band has no `Actions ▾` — its three rows (identity,
            search+Filter, active chips) are the whole workbench; Columns
            lives in the Filter sheet's footer instead (`MobileFilterTier`). */}
        {isPage && !isMobileFilterTier && (
          <ActionsMenu
            table={table}
            entity={entity}
            showColumns={showViewOptions}
            extra={actionsMenuExtra}
          />
        )}
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
}: DataTableToolbarProps<TData>) {
  const workbenchTarget = usePageWorkbenchTarget();
  const isPage = variant === "page";
  const shouldPortal = portalWorkbenchUtilities && workbenchTarget !== null;

  const spinner = isTransitioning && (
    <Row
      align="center"
      gap="xs"
      aria-live="polite"
      className="shrink-0 text-xs text-muted-foreground"
    >
      <Spinner size="sm" />
      Updating…
    </Row>
  );
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
      spinner={spinner}
      additionalContent={additionalContent}
      filterOptionHints={filterOptionHints}
      showViewOptions={showViewOptions}
      actionsMenuExtra={actionsMenuExtra}
      bulkActionBar={bulkActionBar}
      actions={actions}
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
    <div
      data-toolbar-variant={variant}
      className={cn(
        "flex min-w-0 flex-wrap items-center bg-card px-2 py-1",
        variant === "embedded" ? "min-h-8 gap-1" : "min-h-10 gap-2",
        className,
      )}
    >
      {!isPage && (
        <Row align="center" gap="xs" className="shrink-0">
          {problemStatus}
          {embeddedUtilities}
          {spinner}
        </Row>
      )}
      <div className="min-w-0 flex-1">{fieldset}</div>
    </div>
  );
}
