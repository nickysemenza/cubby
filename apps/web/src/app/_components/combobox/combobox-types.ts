import type React from "react";
import { z } from "zod";

export const ComboboxItem = z.object({
  name: z.string(),
  id: z.string(),
});

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
};

export type PickerEntity =
  | "ingredient"
  | "location"
  | "product"
  | "recipe"
  | "project"
  | "task"
  | "vendor"
  | "financialAccount"
  | "purchase";
