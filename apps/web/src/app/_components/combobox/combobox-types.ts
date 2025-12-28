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
};
