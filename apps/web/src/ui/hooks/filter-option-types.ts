import type { PickerOption } from "~/ui/combobox/picker-option";

export interface DeferredFilterOptionSource {
  options: PickerOption[];
  onActivate: (selectedIds?: readonly string[]) => void;
  onSearchChange: (query: string) => void;
  isLoading: boolean;
}

export type RuntimeFilterOptionSource =
  | PickerOption[]
  | DeferredFilterOptionSource;

export type RuntimeFilterOptions = Record<string, RuntimeFilterOptionSource>;

export const filterOptionItems = (
  source: RuntimeFilterOptionSource | undefined,
): PickerOption[] => (Array.isArray(source) ? source : (source?.options ?? []));

export const deferredFilterOptionSource = (
  source: RuntimeFilterOptionSource | undefined,
): DeferredFilterOptionSource | undefined =>
  source && !Array.isArray(source) ? source : undefined;
