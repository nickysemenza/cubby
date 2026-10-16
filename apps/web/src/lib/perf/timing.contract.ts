import { z } from "zod";

const timingResultSchema = z.object({
  label: z.string(),
  durationMs: z.number(),
  error: z.string().optional(),
});

export const timingResponseSchema = z.object({
  results: z.array(timingResultSchema),
  totalMs: z.number(),
});

export type TimingResult = z.infer<typeof timingResultSchema>;
export type TimingResponse = z.infer<typeof timingResponseSchema>;
