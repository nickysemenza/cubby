import type { Rpc } from "@cloudflare/workers-types";

/**
 * The slice of Cloudflare's `WorkflowStep` a Workflow-backed Run uses. A
 * Workflow body takes this instead of the runtime class so its orchestration
 * (step names, waits, failure handling) runs under a faithful in-memory step
 * in unit tests.
 */
export interface DurableSteps {
  do<T extends Rpc.Serializable<T>>(
    name: string,
    config: StepRetries,
    callback: () => Promise<T>,
  ): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
}

export type StepRetries = {
  retries: {
    limit: number;
    delay: `${number} ${"second" | "seconds" | "minute" | "minutes"}`;
    backoff: "constant" | "linear" | "exponential";
  };
};

/** Bookkeeping steps: database writes that only fail on a transient fault. */
export const BOOKKEEPING_RETRIES: StepRetries = {
  retries: { limit: 3, delay: "1 second", backoff: "exponential" },
};

/** Gmail and AI Gateway work: a provider outage gets a few minutes. */
export const PROVIDER_RETRIES: StepRetries = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
};
