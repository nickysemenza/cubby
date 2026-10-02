import { performance } from "node:perf_hooks";
import { z } from "zod";

const stepSchema = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    stepTotal: z.number().int().positive(),
    stepCommand: z.enum([
      "open",
      "wait",
      "click",
      "fill",
      "press",
      "scroll",
      "back",
      "swipe",
      "snapshot",
    ]),
  })
  .refine((step) => step.stepIndex <= step.stepTotal);
let startedAt = performance.now();

// SDK payloads also contain selectors and session paths. Never serialize the
// event; only parsed counters and a fixed command vocabulary reach CI logs.
export default {
  name: "sanitized-native-progress",
  onTestStart() {
    startedAt = performance.now();
  },
  onTestStep(event: unknown) {
    const parsed = stepSchema.safeParse(event);
    if (!parsed.success) return;
    const step = parsed.data;
    console.log(
      `[native-replay] step ${step.stepIndex}/${step.stepTotal} ${step.stepCommand} elapsed=${Math.round(performance.now() - startedAt)}ms`,
    );
  },
};
