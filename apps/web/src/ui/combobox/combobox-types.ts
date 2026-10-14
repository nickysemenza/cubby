import type React from "react";
import { z } from "zod";

export const ComboboxItem = z.object({
  name: z.string(),
  id: z.string(),
});

type PickerTone = "neutral" | "positive" | "warning" | "destructive";

export interface PickerPresentation {
  /** Optional result section. Providers control its order; rows stay stable inside it. */
  group?: {
    id: string;
    label: string;
    order: number;
  };
  /** Distance from the root of a hierarchical picker (0 = root) — indents
   * the row so a tree reads as a tree. `treePickerItems` (`tree-items.ts`)
   * sets this for every parent-linked entity's grouped list. */
  depth?: number;
  /** What the list row shows instead of `name` — a tree node's own label
   * ("Pants") while `name` stays the value the closed control displays and
   * the input filters on ("Apparel / Clothes / Pants"). A row without it
   * renders `name`. */
  rowLabel?: string;
  /** Short action/status cue, e.g. "Need 2" or "In progress". */
  status?: {
    label: string;
    tone?: PickerTone;
  };
  /** Compact evidence beneath the name, rendered in the data voice. */
  facts?: string[];
  /** Known-invalid choices remain explainable but cannot be selected. */
  disabledReason?: string;
  /** Trailing count in the data voice ("254") — see `PickerOption.hint`. */
  hint?: string;
  /** A predicate about the data ("(none)", "Has project") rather than a value
   * from it: eyebrow register, divided from the roster below. */
  meta?: boolean;
}

/**
 * A record's picture as data, so each surface sizes it: the closed field and
 * chips render it at 20px, rows at 24px (`PickerVisual`). A node built for a
 * row (a 52px location tile, a hover preview) cannot be shrunk safely.
 */
export interface PickerThumb {
  imageUrl: string | null;
  /** Rendered centred in the same box when there is no image or it fails. */
  fallback: React.ReactNode;
  shape?: "square" | "round";
}

// Generic ComboboxItem type that preserves ID branding
// TId defaults to string for pickers whose ids are not branded
export type ComboboxItem<TId extends string = string> = {
  /** Canonical value written by the assignment adapter. */
  name: string;
  id: TId;
  /** Public entity identifier — searchable, never displayed or announced. */
  shortcode?: string;
  /** Row glyph. A record also carries `thumb`, which the closed field uses. */
  icon?: React.ReactNode;
  thumb?: PickerThumb;
  /** True while a stored id is still resolving to its record; the closed
   * field shows a quiet loading label instead of the id. */
  pending?: boolean;
  /** Optional categorical swatch used by enum/status pickers. */
  color?: string;
  /** Alternate searchable names. */
  aliases?: string[];
  /** Compact secondary row metadata (manufacturer, location type, etc.). */
  secondary?: string;
  /**
   * Second-line context under the name — a location's ancestor breadcrumb.
   * Distinct from `secondary`, which is a short trailing tag on the name line:
   * this is the longer disambiguator that earns its own row.
   */
  detail?: string;
  /** Contextual ranking and evidence for the shared entity picker. */
  presentation?: PickerPresentation;
};

export type PickerEntity =
  | "ledgerTransfer"
  | "spendingCategory"
  | "ingredient"
  | "location"
  | "product"
  | "productCategory"
  | "recipe"
  | "project"
  | "task"
  | "planting"
  | "vendor"
  | "financialAccount"
  | "purchase"
  | "ledgerParty"
  | "vendorAccount"
  | "plant"
  | "planting";
