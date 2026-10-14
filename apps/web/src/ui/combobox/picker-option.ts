import type React from "react";
import { createElement } from "react";

import type { ComboboxItem } from "./combobox-types";

/**
 * A string-valued choice: an enum, a filter value, a fixed setting. The filter
 * spine (`filter-manifest`, `filter-bar-core`, list-column option builders)
 * declares its options in this shape; `Picker`'s `options` prop maps them onto
 * `ComboboxItem` rows at the boundary.
 */
export interface PickerOption {
  value: string;
  label: string;
  /** Leading glyph — a trade icon, a category mark, a vendor's brand logo. */
  icon?: React.ReactNode;
  color?: string;
  /**
   * Trailing micro-annotation ABOUT the option — today, how many rows carry it
   * ("254"). Deliberately its own field rather than baked into `label`: the
   * label is interpolated verbatim into `LedgerFilters` and the collapsed
   * multi-select summary (`"Amazon (254) +1"` reads as nonsense), and the local
   * type-ahead matches on `label`, so a count in there means typing digits
   * filters the roster by its counts.
   */
  hint?: string;
  /**
   * Second-line prose that DISAMBIGUATES the option — today, a location's
   * ancestor breadcrumb, because "shelf 1" exists in four rooms. Stays out of
   * `label` for the same interpolation reason as `hint`.
   */
  detail?: string;
  /** What choosing the option means — a tooltip on surfaces that show the stored value. */
  description?: string;
  /**
   * A meta option is a predicate ABOUT the data (e.g. "Has project" / "(none)"
   * nullable-filter sentinels), not a value drawn FROM it — it renders in the
   * eyebrow register above a divider. `label` still MUST stay a plain string:
   * `LedgerFilters` and the collapsed multi-select summary interpolate it.
   */
  meta?: boolean;
  /** Optional result section for a hierarchical roster (`treePickerItems`). */
  group?: { id: string; label: string; order: number };
  /** Distance from the root of a hierarchical roster (0 = root). */
  depth?: number;
  /** Compact row text when `label` contains the complete ancestry path. */
  rowLabel?: string;
  /** Shown under a choice that stays visible but cannot be picked. */
  disabledReason?: string;
}

/** The one `PickerOption` → picker row mapping. */
export function pickerOptionItem(option: PickerOption): ComboboxItem {
  const presentation: NonNullable<ComboboxItem["presentation"]> = {
    ...(option.group && { group: option.group }),
    ...(option.depth != null && { depth: option.depth }),
    ...(option.rowLabel && { rowLabel: option.rowLabel }),
    ...(option.hint && { trailing: [{ text: option.hint }] }),
    ...(option.meta && { meta: true }),
    ...(option.disabledReason && {
      disabledReason: option.disabledReason,
    }),
  };
  return {
    id: option.value,
    name: option.label,
    // An option's colour tints its glyph; only a glyph-less option shows the
    // colour as a swatch, so a row never carries both marks.
    ...(option.icon != null
      ? {
          icon: createElement(
            "span",
            {
              "aria-hidden": true,
              "data-enum-option-icon": "",
              className: "flex items-center [&>svg]:size-3.5!",
              style: { color: option.color },
            },
            option.icon,
          ),
        }
      : option.color
        ? { color: option.color }
        : {}),
    ...(option.detail && { detail: option.detail }),
    ...(Object.keys(presentation).length > 0 && { presentation }),
  };
}
