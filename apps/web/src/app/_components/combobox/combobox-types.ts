"use client";

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
};

// Legacy non-generic type for Zod inference (deprecated, use generic version)
export type ComboboxItemLegacy = z.infer<typeof ComboboxItem>;
