import type React from "react";
import { z } from "zod";

import type { DetailEntity } from "~/entity/generated/entity-details.gen";
import type { ListEntity } from "~/entity/generated/entity-lists.gen";

export const ComboboxItem = z.object({
  name: z.string(),
  id: z.string(),
});

export type PickerTone = "neutral" | "positive" | "warning" | "destructive";

/**
 * One right-aligned data chip on a row — a count, a price, an on-hand
 * figure, a confidence. `text` is what the row announces; `node` is the
 * formatted display when it differs (a currency value), never interactive.
 */
export interface PickerChip {
  text: string;
  tone?: PickerTone;
  node?: React.ReactNode;
}

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
  /** Right-aligned data chips, in order: counts, prices, status cues. */
  trailing?: PickerChip[];
  /** Known-invalid choices remain explainable but cannot be selected. */
  disabledReason?: string;
  /** A predicate about the data ("(none)", "Has project") rather than a value
   * from it: eyebrow register, divided from the roster below. */
  meta?: boolean;
}

/**
 * A record's picture as data, so each surface sizes it (`PickerVisual`): 20px
 * in the closed field and rows, 16px in chips.
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
  /** An option's glyph (already tinted). Records carry `thumb` instead. */
  icon?: React.ReactNode;
  thumb?: PickerThumb;
  /** True while a stored id is still resolving to its record; the closed
   * field shows a quiet loading label instead of the id. */
  pending?: boolean;
  /** Optional categorical swatch used by enum/status pickers. */
  color?: string;
  /** Alternate searchable names. */
  aliases?: string[];
  /** Muted text inline after the name — the manifest's card subtitle
   * (manufacturer, location type). */
  secondary?: string;
  /**
   * Second-line context under the name — a location's ancestor breadcrumb, a
   * search match reason. Rows stay one line without it.
   */
  detail?: string;
  /** Contextual ranking and evidence for the shared entity picker. */
  presentation?: PickerPresentation;
};

/** Every entity with a list (candidates) and a detail read (a stored code's
 * record) can be picked. */
export type PickerEntity = Extract<DetailEntity, ListEntity>;
