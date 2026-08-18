import type { Entity } from "@cubby/schemas/entity";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { Row } from "~/components/layout";
import { usePageIdentity } from "~/components/page/Page";
import { Spinner } from "~/components/ui/spinner";
import { cn, formatCount } from "~/lib/utils";
import { DataTableViews } from "./DataTableViews";
import { DataTableViewOptions } from "./data-table-view-options";
import { LedgerFilters } from "./LedgerFilters";
import { ProblemWorklistStatus } from "./problem-worklist";
import type { CubbyTable as Table } from "./table-features";

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
  /**
   * Carry the page's identity (name, count, actions) on this bar. Set only for
   * the page-level table; an embedded table sits under a section heading that
   * already names it.
   */
  ownsPageIdentity?: boolean;
}

/**
 * The page's name and record count, laid onto the toolbar's left.
 *
 * `h1` because this IS the page heading once the header block above is gone —
 * folding the title into the bar must not cost the document its top-level
 * landmark. Space Grotesk at title scale (not display) so it sits on the bar's
 * 28px control rhythm, with the count in mono as a measurement.
 */
function ToolbarIdentity() {
  const identity = usePageIdentity();
  if (!identity) return null;
  return (
    <Row align="baseline" gap="sm" className="min-w-0 shrink">
      <h1 className="min-w-0 truncate font-bold font-heading text-base tracking-tight">
        {identity.title}
      </h1>
      {identity.count !== undefined && (
        <span className="shrink-0 font-mono text-2xs text-slate uppercase tabular-nums tracking-wider">
          {formatCount(identity.count)}
        </span>
      )}
    </Row>
  );
}

/** The page's own actions, which the removed header block used to carry. */
function PageIdentityActions() {
  const identity = usePageIdentity();
  if (!identity?.actions) return null;
  return <>{identity.actions}</>;
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
  ownsPageIdentity = false,
}: DataTableToolbarProps<TData>) {
  return (
    <Row align="center" justify="between" gap="sm" className={className}>
      <Row align="center" gap="sm" className="min-w-0">
        {ownsPageIdentity && <ToolbarIdentity />}
        {entity && (
          <ProblemWorklistStatus
            entity={entity}
            filters={table.state.columnFilters}
            sorting={table.state.sorting}
          />
        )}
        {showViewOptions && <DataTableViewOptions table={table} />}
        <DataTableViews table={table} entity={entity} />
        <fieldset disabled={isTransitioning} className="contents">
          {bulkActionBar}
        </fieldset>
        {isTransitioning && (
          <Row
            align="center"
            gap="xs"
            aria-live="polite"
            className="text-muted-foreground text-xs"
          >
            <Spinner size="sm" />
            Updating…
          </Row>
        )}
      </Row>

      <Row
        align="center"
        gap="sm"
        wrap
        className={cn(
          "min-w-0 flex-1",
          showViewOptions || bulkActionBar ? "justify-end" : "justify-start",
        )}
      >
        {additionalContent}

        <div className="order-last w-full min-w-0 lg:order-none lg:w-auto">
          <LedgerFilters table={table} />
        </div>

        <fieldset disabled={isTransitioning} className="contents">
          {actions}
          {ownsPageIdentity && <PageIdentityActions />}
        </fieldset>
      </Row>
    </Row>
  );
}
