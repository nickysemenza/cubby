import type { ColumnCellData } from "./cell-data";
import type { FilterableComboboxItem } from "./editable-cell";
import type { CubbyTableLayoutV1 } from "./table-layout";

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

/** Per-column Cubby rendering and editing conventions, bound through v9's meta slot. */
export interface CubbyColumnMeta {
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
  // Column arrays intentionally erase their heterogeneous row/value types at
  // the shared chrome seam. Factories still retain TData at their call sites.
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table metadata
  cellData?: ColumnCellData<any>;
}

export interface ServerTotals {
  totalCount: number;
  sums?: Record<string, number>;
}

export interface CubbyTableMeta {
  serverTotals?: ServerTotals;
  urlScopeCount?: number;
  rowContentVersion?: unknown;
  /** Code-defined layout used to normalize persisted and saved layouts. */
  defaultLayout?: CubbyTableLayoutV1;
}
