import type { Entity, EntityRef } from "@cubby/schemas/entity";
import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import { humanize, type NumberRange } from "@cubby/shared";
import type { CellData, RowData } from "@tanstack/react-table";
import { type ReactNode, useEffect } from "react";

import type { PickerRecordSource } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";

import type { ColumnCellData } from "./cell-data";
import type { CubbyDefaultTableLayout } from "./column-layout";
import type { FilterBarField, FilterValueType } from "./filter-bar-core";
import type { CubbyColumn, CubbyTable } from "./table-features";

/** Configuration for an inline column-header filter. */
export interface FilterConfig {
  placeholder: string;
  /** The filter's declared name; it wins over the hosting column's header. */
  label?: string;
  filterType?: "text" | "select" | "multiselect";
  /** The declared filter kind (`multiselect`, `idMulti`, `range`, …). */
  kind?: string;
  /** What the values are; drives the panel's type glyph and editor. */
  valueType?: FilterValueType;
  /** The entity an `entity` filter's values are records of. */
  referenceEntity?: string;
  /** The Filters panel section (the field's edit section, else by type). */
  group?: string;
  /** The type glyph override (an entity filter's entity icon). */
  icon?: ReactNode;
  /** A multiselect with no roster: its values are typed, comma-separated. */
  freeText?: boolean;
  /** Filters sharing a group hold one value between them: picking replaces. */
  exclusiveGroup?: string;
  options?: PickerOption[];
  /** A multi-valued field: the editor offers Match any | Match all. */
  matchAll?: boolean;
  /** A hierarchical reference: the editor shows its "Include sub-…" toggle. */
  subtree?: { label: string };
  /** A value filter with an Exclude key: the editor offers is | is not. */
  exclude?: boolean;
  /** A date range: beside its presets the editor sets `from..to` bounds. */
  dateRange?: boolean;
  /** A number range: beside its presets the editor sets `min..max` bounds. */
  numberRange?: NumberRange;
  /** Client-side facet hints are opt-in because most Cubby tables are server-backed. */
  facetCount?: boolean;
  /** Deferred/server-backed option roster activation and search controls. */
  onActivate?: (selectedIds?: readonly string[]) => void;
  onSearchChange?: (query: string) => void;
  isLoading?: boolean;
  /** A roster of one entity's records: its pickers run in record mode. */
  records?: PickerRecordSource;
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
  /** Retain a semantic null state rendered by the cell, such as Not assessed. */
  showWhenEmpty?: boolean;
  /** Preserve a resolved identity link instead of its shortcode accessor. */
  renderTitle?: boolean;
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

export type ColumnExplanation = {
  entity: EntityRef["entityKind"];
  field: string;
  label: string;
};

export type RowColumnExplanation<TData> = {
  resolve: (row: TData) => ColumnExplanation | undefined;
};

/** Per-column Cubby rendering and editing conventions, bound through v9's meta slot. */
export interface CubbyColumnMeta<TData = CellData> {
  /** Stable table role; layout and styling must not infer this from an id. */
  entityColumnRole?: EntityColumnRole;
  /** The declaration's thematic band; columns in a band move and pin together. */
  columnGroup?: string;
  /** Generated origin metadata for relation-backed or computed values. */
  provenance?: EntityFieldProvenance | null;
  /** Fetchable explanation for a manifest-declared computed value. */
  explanation?: ColumnExplanation | RowColumnExplanation<TData>;
  /** Specialist cell already supplies the relation workbench interaction. */
  provenanceWorkbenchHandled?: boolean;
  mobile?: MobileColumnMeta;
  className?: string;
  /** The field renders an AI suggestion mark in the cell rail. */
  suggest?: boolean;
  /**
   * The header's painted label when it is shorter than `header` ("Expenses"
   * for "Expense count"). `header` stays the accessible name and tooltip.
   */
  shortHeader?: string;
  /**
   * The column counts one entity's records: its header paints that entity's
   * icon and "#" instead of a label, unless another visible column counts
   * the same entity.
   */
  countOf?: Entity;
  /**
   * Every value links to one entity's records: the header paints that
   * entity's icon once and each link drops its generic icon
   * (`DenseCellContext`), keeping record images and marks.
   */
  linksTo?: Entity;
  numeric?: boolean;
  /**
   * What the column holds, for its header glyph. Omitted, the header derives
   * it from `linksTo`, `numeric` and the filter config.
   */
  valueKind?: ColumnValueKind;
  mono?: boolean;
  /**
   * A code or identifier (barcode, shortcode): its fitted width stops at the
   * code cap. `mono` alone also sets timestamps and model names, which keep
   * the text cap.
   */
  code?: boolean;
  filterConfig?: FilterConfig;
  cellData?: ColumnCellData<TData>;
  /** Authoritative list inputs when a display column has another id. */
  readFields?: readonly string[];
  /** Deferred values must render their state without invoking data accessors. */
  valueUnavailable?: (row: TData) => boolean;
  /** A present value the cell deliberately paints as nothing. */
  rendersBlank?: (row: TData) => boolean;
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

/** A column's value kind, shown as a muted glyph before its header label. */
export type ColumnValueKind =
  | "text"
  | "enum"
  | "date"
  | "money"
  | "number"
  | "person"
  | "boolean";

/** A Group by choice the table's header menu can offer for its column. */
interface TableGroupChoice {
  reason?: string | null;
  key: string;
  /** The column the choice groups by; its header offers "Group by". */
  columnId: string;
  label: string;
}

export interface ServerTotals {
  totalCount?: number;
  sums?: Record<string, number>;
}

export interface CubbyTableMeta {
  /** All rows are loaded: filter counts may be computed from this table's row model. */
  completeLocalData?: boolean;
  /** Primary search for a bounded, non-entity list; its key hosts a text accessor. */
  primarySearch?: { key: string; placeholder: string };
  /** Bounded server contracts can narrow the shared pager choices. */
  pageSizeOptions?: readonly number[];
  serverTotals?: ServerTotals;
  /**
   * Filters-menu fields for declared filters no column hosts (a relation
   * scope such as expenses' `productId`); their values ride in
   * `columnFilters` beside the column-hosted ones.
   */
  filterFields?: readonly FilterBarField[];
  rowContentVersion?: unknown;
  /** Semantic server scope, including filters not represented by table controls. */
  valueChangeScope?: string;
  /** Code-defined layout a "Customized" badge and "Restore default" compare against. */
  defaultLayout?: CubbyDefaultTableLayout;
  /**
   * Stable id for the desktop scroll pane. Routed through meta rather than an
   * RTable prop so every existing call site gets pane scroll restoration
   * without threading a new argument.
   */
  scrollRestorationId?: string;
  /** Group by choices headers may offer, the active one, and its setter. */
  grouping?: {
    choices: readonly TableGroupChoice[];
    active: string | null;
    onChange: (key: string | null) => void;
  };
}

/** A column's label on a phone: its mobile label, its header text, or its humanized id. */
export function mobileColumnLabel<TItem extends RowData>(
  column: CubbyColumn<TItem, unknown>,
): string {
  const meta = column.columnDef.meta;
  const header = column.columnDef.header;
  if (meta?.mobile?.label) return meta.mobile.label;
  if (isNonEmptyHeaderLabel(header)) return header;
  return humanize(column.id);
}

function isNonEmptyHeaderLabel<TItem extends RowData>(
  header: CubbyColumn<TItem, unknown>["columnDef"]["header"],
): header is string {
  return typeof header === "string" && header.trim().length > 0;
}

/**
 * A column header asks the table's filter editor to open one column's editor.
 *
 * The header and the editor render in different subtrees and one editor owns
 * each table: the toolbar's filter bar, or a header-anchored panel when the
 * table has no toolbar. Filter values stay in the table's state. Keyed by the
 * table instance so two tables on a page never cross wires.
 */
type Listener = (columnId: string, anchor?: Element | null) => void;

const listeners = new WeakMap<WeakKey, Set<Listener>>();

export function requestColumnFilterEdit<TData extends RowData>(
  table: CubbyTable<TData>,
  columnId: string,
  /** The header the editor opens beside when no toolbar hosts it. */
  anchor?: Element | null,
) {
  for (const listener of listeners.get(table) ?? []) listener(columnId, anchor);
}

/** Whether some filter editor is listening, so a header offers "Filter…" only when it can open. */
export function hasColumnFilterEditor<TData extends RowData>(
  table: CubbyTable<TData>,
): boolean {
  return (listeners.get(table)?.size ?? 0) > 0;
}

/** A filter editor's subscription to header requests for `table`. */
export function useColumnFilterEditRequests<TData extends RowData>(
  table: CubbyTable<TData>,
  onRequest: Listener,
) {
  useEffect(() => {
    const set = listeners.get(table) ?? new Set<Listener>();
    listeners.set(table, set);
    set.add(onRequest);
    return () => {
      set.delete(onRequest);
    };
  }, [table, onRequest]);
}
