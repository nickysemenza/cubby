import type { EntityRef } from "@cubby/schemas/entity";
import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import type { CellData, RowData } from "@tanstack/react-table";

import type { ColumnCellData } from "./cell-data";
import type { CubbyDefaultTableLayout } from "./column-layout";
import type { FilterableComboboxItem } from "./editable-cell";

/** Configuration for an inline column-header filter. */
export interface FilterConfig {
  placeholder: string;
  filterType?: "text" | "select" | "multiselect";
  options?: FilterableComboboxItem[];
  /** Client-side facet hints are opt-in because most Cubby tables are server-backed. */
  facetCount?: boolean;
  /** Deferred/server-backed option roster activation and search controls. */
  onActivate?: (selectedIds?: readonly string[]) => void;
  onSearchChange?: (query: string) => void;
  isLoading?: boolean;
}

export type MobileSlot =
  | "title"
  | "subtitle"
  | "meta"
  | "trailing"
  | "image"
  | "actions"
  | "hidden";

export interface MobileColumnMeta {
  slot?: MobileSlot;
  /** Lower values render first within a slot. */
  priority?: number;
  /** Keep interactive controls out of the mobile card's truncating wrapper. */
  interactive?: boolean;
  /** Short label for the narrow mobile spec-grid gutter. */
  label?: string;
}

/** Structural meaning shared by manifest-built and specialist columns. */
export type EntityColumnRole =
  | "selection"
  | "image"
  | "identity"
  | "fact"
  | "action";

/** Per-column Cubby rendering and editing conventions, bound through v9's meta slot. */
export interface CubbyColumnMeta<TData = CellData> {
  /** Stable table role; layout and styling must not infer this from an id. */
  entityColumnRole?: EntityColumnRole;
  /** Generated origin metadata for relation-backed or computed values. */
  provenance?: EntityFieldProvenance | null;
  /** Specialist cell already supplies the relation workbench interaction. */
  provenanceWorkbenchHandled?: boolean;
  mobile?: MobileColumnMeta;
  className?: string;
  /**
   * Receives the unused desktop table width after the visible fixed columns
   * have been measured. Name-like record identity belongs here, not in a
   * trailing empty gutter or spread across every measurement column.
   */
  surplus?: boolean;
  numeric?: boolean;
  mono?: boolean;
  filterConfig?: FilterConfig;
  cellData?: ColumnCellData<TData>;
  /** Public refs rendered by this column, collected once at the table owner. */
  entityRefs?: (row: TData) => readonly EntityRef[];
}

/**
 * Attach row-correlated cell metadata to TanStack's non-row-generic meta slot.
 * Callers retain their exact callback inputs until this single adapter.
 */
export function attachCubbyColumnMeta<TData extends RowData>(
  meta: CubbyColumnMeta<TData>,
): CubbyColumnMeta {
  // SAFETY: this metadata is attached only to a ColumnDef<TData> created by the
  // same column factory. TanStack carries meta without invoking it; every reader
  // supplies row.original from that same table's TData before a callback runs.
  return meta as CubbyColumnMeta;
}

export interface ServerTotals {
  totalCount: number;
  sums?: Record<string, number>;
}

export interface CubbyTableMeta {
  serverTotals?: ServerTotals;
  urlScopeCount?: number;
  rowContentVersion?: unknown;
  /** Code-defined layout a "Customized" badge and "Restore default" compare against. */
  defaultLayout?: CubbyDefaultTableLayout;
  /**
   * Stable id for the desktop scroll pane. Routed through meta rather than an
   * RTable prop so every existing call site gets pane scroll restoration
   * without threading a new argument.
   */
  scrollRestorationId?: string;
}
