"use client";

import { z } from "zod";

export const ComboboxItem = z.object({
  name: z.string(),
  id: z.string(),
});
export const NullableComboboxItem = ComboboxItem.nullable();

export type ComboboxItem = z.infer<typeof ComboboxItem>;
export type NullableComboboxItem = z.infer<typeof NullableComboboxItem>;
