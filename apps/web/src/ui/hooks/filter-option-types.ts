import type { PickerRecordSource } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";

export interface DeferredFilterOptionSource {
  options: PickerOption[];
  onActivate: (selectedIds?: readonly string[]) => void;
  onSearchChange: (query: string) => void;
  isLoading: boolean;
  /** A roster of one entity's records: its pickers run in record mode. */
  records?: PickerRecordSource;
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

/** The `FilterConfig` controls a deferred roster drives. */
export const deferredRosterControls = (
  source: DeferredFilterOptionSource | undefined,
) => ({
  onActivate: source?.onActivate,
  onSearchChange: source?.onSearchChange,
  isLoading: source?.isLoading,
  records: source?.records,
});
