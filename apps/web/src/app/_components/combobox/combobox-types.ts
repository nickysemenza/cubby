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
  /** Short action/status cue, e.g. "Need 2" or "In progress". */
  status?: {
    label: string;
    tone?: PickerTone;
  };
  /** Compact evidence beneath the name, rendered in the data voice. */
  facts?: string[];
  /** Known-invalid choices remain explainable but cannot be selected. */
  disabledReason?: string;
}

// Generic ComboboxItem type that preserves ID branding
// TId defaults to string for backward compatibility
export type ComboboxItem<TId extends string = string> = {
  /** Canonical value written by the assignment adapter. */
  name: string;
  id: TId;
  /** Public entity identifier displayed in picker result rows. */
  shortcode?: string;
  icon?: React.ReactNode;
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
  | "planting";
