import { z } from "zod";

export const aiAnalysisEntityKind = z.enum([
  "image",
  "location",
  "product",
  "recipe",
  "run",
  "global",
]);
export type AiAnalysisEntityKind = z.infer<typeof aiAnalysisEntityKind>;
