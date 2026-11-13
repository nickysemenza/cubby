import { z } from "zod";
export const suggestionValueSchema = z.json();
export type SuggestionValue = z.infer<typeof suggestionValueSchema>;
