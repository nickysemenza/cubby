import type { Table } from "@tanstack/react-table";
import { X } from "lucide-react";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import type { FilterConfig } from "./columnHelpers";

interface ActiveFilterChipsProps<TData> {
  table: Table<TData>;
}

interface FilterChipShellProps {
  name: string;
  value: string;
  onClear: () => void;
  clearLabel: string;
}

/**
 * The removable-chip shell shared by column-filter chips (below) and
 * `ScopeChip` (a deep-link scope with no backing column — see its own doc).
 * Only the markup is shared: the two callers build their `onClear` very
 * differently, so the chip-building logic itself stays separate.
 */
function FilterChipShell({
  name,
  value,
  onClear,
  clearLabel,
}: FilterChipShellProps) {
  return (
    <Badge variant="outline" className="gap-1 pr-1">
      <span className="text-muted-foreground">{name}:</span>
      <span className="font-sans normal-case tracking-normal">{value}</span>
      <button
        type="button"
        aria-label={clearLabel}
        onClick={onClear}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}

interface ScopeChipProps {
  /** e.g. "Product" — reads as a scope, not a filter value. */
  name: string;
  /** The resolved display value, e.g. a product name — never a raw id. */
  value: string;
  onClear: () => void;
}

/**
 * A removable chip for state that narrows the table but isn't a TanStack
 * column filter — e.g. `/purchases?productId=<uuid>`, seeded straight from
 * the URL with no header control behind it (see `purchaselist.tsx`). Visually
 * identical to a column-filter chip via the shared `FilterChipShell` so it
 * doesn't read as a second dialect.
 */
export function ScopeChip({ name, value, onClear }: ScopeChipProps) {
  return (
    <FilterChipShell
      name={name}
      value={value}
      onClear={onClear}
      clearLabel={`Clear ${name} scope`}
    />
  );
}

/**
 * What's currently filtered, as removable chips.
 *
 * The readout multi-select needs: a header cell collapses several selections
 * to `Drywall +2`, and a column scrolled out of view shows nothing at all, so
 * without this the only signal that a table is filtered is the Reset button —
 * which clears everything at once rather than the one filter you meant.
 *
 * Labels come from each column's `filterConfig` (manifest-driven), so a chip
 * reads "Trade: Drywall +1" rather than exposing the raw enum value.
 */
export function ActiveFilterChips<TData>({
  table,
}: ActiveFilterChipsProps<TData>) {
  const columnFilters = table.getState().columnFilters;
  if (columnFilters.length === 0) return null;

  const chips = columnFilters.flatMap((filter) => {
    const column = table.getColumn(filter.id);
    if (!column) return [];

    const config = column.columnDef.meta?.filterConfig as
      | FilterConfig
      | undefined;

    const values = Array.isArray(filter.value)
      ? (filter.value as string[])
      : [String(filter.value ?? "")];
    if (values.length === 0 || values[0] === "") return [];

    const label = (value: string) =>
      config?.options?.find((opt) => opt.value === value)?.label ?? value;

    const first = values[0] as string;
    const summary =
      values.length > 1
        ? `${label(first)} +${values.length - 1}`
        : label(first);

    // The header text is the column's own; fall back to the id for columns
    // whose header is a render function rather than a string.
    const header = column.columnDef.header;
    const name = typeof header === "string" ? header : filter.id;

    return [{ id: filter.id, name, summary, column }];
  });

  if (chips.length === 0) return null;

  return (
    <Row align="center" gap="xs" wrap>
      {chips.map((chip) => (
        <FilterChipShell
          key={chip.id}
          name={chip.name}
          value={chip.summary}
          onClear={() => chip.column.setFilterValue(undefined)}
          clearLabel={`Clear ${chip.name} filter`}
        />
      ))}
    </Row>
  );
}
