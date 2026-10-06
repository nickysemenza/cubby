import type { DurableSteps } from "~/server/workflow-runs/step";

/**
 * An in-memory `DurableSteps` with Cloudflare's replay semantics: a step
 * whose name already completed returns its saved result without running, a
 * failing callback is retried up to `retries.limit` more times before the
 * error escapes, and a completed sleep is not slept again. Pass the
 * `completed` map from an earlier execution to replay an interrupted one.
 */
export interface MemoryDurableSteps {
  steps: DurableSteps;
  completed: Map<string, unknown>;
  /** Every callback execution, as `<name>#<attempt>`. */
  attempts: string[];
  sleeps: { name: string; durationMs: number }[];
}

export function memoryDurableSteps(
  completed = new Map<string, unknown>(),
): MemoryDurableSteps {
  const attempts: string[] = [];
  const sleeps: { name: string; durationMs: number }[] = [];
  const steps: DurableSteps = {
    async do(name, config, callback) {
      if (completed.has(name))
        // SAFETY: the map only holds values this same step name returned.
        return completed.get(name) as Awaited<ReturnType<typeof callback>>;
      for (let attempt = 1; ; attempt += 1) {
        attempts.push(`${name}#${attempt}`);
        try {
          const value = await callback();
          completed.set(name, structuredClone(value));
          return value;
        } catch (error) {
          if (attempt > config.retries.limit) throw error;
        }
      }
    },
    async sleep(name, durationMs) {
      if (completed.has(name)) return;
      sleeps.push({ name, durationMs });
      completed.set(name, null);
    },
  };
  return { steps, completed, attempts, sleeps };
}
