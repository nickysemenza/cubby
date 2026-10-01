import { sleep } from "../../packages/shared/src/retry.ts";

export interface PollOptions {
  /** Names the wait in the timeout error. */
  label: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** Checked before every attempt; true abandons the wait. */
  aborted?: () => boolean;
  /** Treat a throw from `read` as "not ready yet" instead of failing the wait. */
  retryOnError?: boolean;
}

/**
 * Re-run `read` until it returns a value other than `undefined`, then return
 * it. A throw fails the wait unless `retryOnError` is set, in which case the
 * last throw is the cause of the timeout error. One deadline loop for every
 * script and tooling wait.
 *
 * TODO(reconcile): promote into `@cubby/shared/retry` beside `sleep` once the
 * server lane's `pollUntil` lands, and re-export that from here.
 */
export async function pollUntil<T>(
  read: () => Promise<T | undefined> | T | undefined,
  {
    label,
    timeoutMs = 60_000,
    intervalMs = 250,
    aborted = () => false,
    retryOnError = false,
  }: PollOptions,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    if (aborted()) throw new Error(`${label} wait aborted`);
    try {
      const value = await read();
      if (value !== undefined) return value;
      failure = undefined;
    } catch (error) {
      if (!retryOnError) throw error;
      failure = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: failure });
}
