import { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";

type AttemptResult = { result: unknown; noModelCall?: boolean };
type UsageSummary = {
  feature: string;
  model: string;
  cacheStatus: "hit" | "miss" | "none" | null;
  applicationCacheStatus: "hit" | "miss" | "none" | null;
};

export function withSmokeUsage<
  T extends Awaited<ReturnType<typeof finishSmokeAttempt>>,
>(attempt: T, usages: UsageSummary[]) {
  const actual = (key: "feature" | "model") =>
    [...new Set(usages.map((usage) => usage[key]))].join(", ");
  const noModelCall = usages.every(
    (usage) =>
      usage.applicationCacheStatus === "hit" || usage.cacheStatus === "hit",
  );
  return {
    ...attempt,
    feature: actual("feature") || attempt.feature,
    model: actual("model") || attempt.model,
    status:
      attempt.status === "ok" && noModelCall
        ? ("no_model_call" as const)
        : attempt.status,
  };
}

/** A Run exists before this starts, so even model and source failures retain its link. */
export async function finishSmokeAttempt(
  spec: { feature: string; model: string },
  runShortcode: string,
  work: () => Promise<AttemptResult>,
  now: () => number = () => performance.now(),
) {
  const start = now();
  try {
    const { result, noModelCall } = await work();
    return {
      status: noModelCall ? ("no_model_call" as const) : ("ok" as const),
      feature: spec.feature,
      model: spec.model,
      runShortcode,
      durationMs: Math.round(now() - start),
      result: z.json().parse(JSON.parse(JSON.stringify(result ?? null))),
    };
  } catch (error) {
    return {
      status: "error" as const,
      feature: spec.feature,
      model: spec.model,
      runShortcode,
      durationMs: Math.round(now() - start),
      error: getErrorMessage(error),
    };
  }
}
