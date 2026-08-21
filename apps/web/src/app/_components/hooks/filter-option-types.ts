import type { FilterableComboboxItem } from "~/components/ui/combobox";

export interface DeferredFilterOptionSource {
  options: FilterableComboboxItem[];
  onActivate: (selectedIds?: readonly string[]) => void;
  onSearchChange: (query: string) => void;
  isLoading: boolean;
}

export type RuntimeFilterOptionSource =
  | FilterableComboboxItem[]
  | DeferredFilterOptionSource;

export type RuntimeFilterOptions = Record<string, RuntimeFilterOptionSource>;

export const filterOptionItems = (
  source: RuntimeFilterOptionSource | undefined,
): FilterableComboboxItem[] =>
  Array.isArray(source) ? source : (source?.options ?? []);

export const deferredFilterOptionSource = (
  source: RuntimeFilterOptionSource | undefined,
): DeferredFilterOptionSource | undefined =>
  source && !Array.isArray(source) ? source : undefined;
