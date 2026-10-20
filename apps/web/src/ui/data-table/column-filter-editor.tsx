import type { RowData } from "@tanstack/react-table";
import { useEffect, useSyncExternalStore } from "react";

import { FilterFieldEditor } from "./filter-bar";
import {
  type Filter,
  type FilterBarField,
  operatorFor,
} from "./filter-bar-core";
import type { CubbyTable } from "./table-features";

type FilterEditorState = {
  fields: FilterBarField[];
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
  onEditorChange: (key: string | null) => void;
};
const editors = new WeakMap<WeakKey, FilterEditorState>();
const listeners = new WeakMap<WeakKey, Set<() => void>>();

/** The bar publishes the same live draft and facet roster to its column menus. */
export function usePublishColumnFilters<TData extends RowData>(
  table: CubbyTable<TData>,
  state: FilterEditorState,
  enabled = true,
) {
  const { fields, filters, onChange, onEditorChange } = state;
  useEffect(() => {
    if (!enabled) return;
    editors.set(table, { fields, filters, onChange, onEditorChange });
    listeners.get(table)?.forEach((notify) => notify());
  }, [table, fields, filters, onChange, onEditorChange, enabled]);
  useEffect(
    () => () => {
      if (!enabled) return;
      editors.delete(table);
      listeners.get(table)?.forEach((notify) => notify());
    },
    [table, enabled],
  );
}

export function ColumnFilterEditor<TData extends RowData>({
  table,
  columnId,
}: {
  table: CubbyTable<TData>;
  columnId: string;
}) {
  const state = useSyncExternalStore(
    (notify) => {
      const set = listeners.get(table) ?? new Set();
      listeners.set(table, set);
      set.add(notify);
      return () => {
        set.delete(notify);
      };
    },
    () => editors.get(table),
    () => undefined,
  );
  const activate = state?.onEditorChange;
  useEffect(() => {
    activate?.(columnId);
    return () => activate?.(null);
  }, [activate, columnId]);
  const field = state?.fields.find((candidate) => candidate.key === columnId);
  if (!state || !field) return null;
  const filter = state.filters.find(
    (candidate) => candidate.field === columnId,
  );
  const rest = state.filters.filter(
    (candidate) => candidate.field !== columnId,
  );
  const clear = () => state.onChange(rest);
  return (
    <fieldset
      className="border-y border-hairline-soft px-2 py-2"
      aria-label={`Filter ${field.label ?? columnId}`}
    >
      <p className="text-pill mb-1.5 font-medium text-muted-foreground">
        Filter · {field.type === "multiselect" ? "is any of" : "is"}
      </p>
      <FilterFieldEditor
        field={field}
        filter={filter}
        clear={clear}
        setValues={(values) =>
          state.onChange(
            values.length
              ? [
                  ...rest,
                  {
                    id: filter?.id ?? `filter-${columnId}`,
                    field: columnId,
                    operator: operatorFor(field),
                    values,
                  },
                ]
              : rest,
          )
        }
      />
    </fieldset>
  );
}
