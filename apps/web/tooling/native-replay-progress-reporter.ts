import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { readReplayTextEntryDiagnostics } from "./native-text-entry-diagnostics.ts";

const resultSchema = z.object({
  status: z.literal("fail"),
  session: z.string().min(1).max(512),
});

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
  onTestResult(event: unknown) {
    const directory = process.env.CUBBY_NATIVE_DIAGNOSTICS_DIR;
    const parsed = resultSchema.safeParse(event);
    if (!directory || !parsed.success) return;
    const diagnostics = readReplayTextEntryDiagnostics(
      tmpdir(),
      parsed.data.session,
    );
    if (!diagnostics) return;
    try {
      writeFileSync(
        join(directory, "native-text-entry-diagnostics.json"),
        `${JSON.stringify(diagnostics, null, 2)}\n`,
      );
    } catch {
      console.warn("[native-replay] Text entry diagnostics unavailable");
    }
  },
};
