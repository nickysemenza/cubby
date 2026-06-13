import type React from "react";
import { z } from "zod";

export const ComboboxItem = z.object({
  name: z.string(),
  id: z.string(),
});

// Generic ComboboxItem type that preserves ID branding
// TId defaults to string for backward compatibility
export type ComboboxItem<TId extends string = string> = {
  name: string;
  id: TId;
  icon?: React.ReactNode;
  // Optional aliases, carried for ingredient items so a row's drift check can
  // recognize an alias match on manual selection. Unused by other entity types.
  aliases?: string[];
};
