"use client";

import { z } from "zod";

export const ComboboxItem = z.object({
  name: z.string(),
  id: z.string(),
});

export type ComboboxItem = z.infer<typeof ComboboxItem>;
