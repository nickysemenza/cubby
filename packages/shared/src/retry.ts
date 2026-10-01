/** Resolve after `ms`; reject with `signal.reason` if the signal aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** What one attempt produced, handed to `delayFor` to decide on a retry. */
export type RetryOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface RetryOptions<T> {
  /**
   * Milliseconds to wait before the next attempt, or `null` to stop: a stopped
   * success is returned and a stopped failure is rethrown. `attempt` is the
   * zero-based index of the attempt that just finished, so the call that
   * allows N attempts returns `null` once `attempt >= N - 1`.
   */
  delayFor: (outcome: RetryOutcome<T>, attempt: number) => number | null;
  /** Aborts the wait between attempts (the attempt itself owns its own signal). */
  signal?: AbortSignal;
  /** Injected by tests that must not really wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Run `run` until `delayFor` says stop. The policy (which status or error is
 * transient, how long to wait, how many attempts) stays with the caller; this
 * owns only the loop, so Gmail's HTTP statuses, Jev's deadline-bounded 429s and
 * a throttled Vectorize write share one implementation.
 */
export async function retryWithBackoff<T>(
  run: (attempt: number) => Promise<T>,
  options: RetryOptions<T>,
): Promise<T> {
  const wait = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    let outcome: RetryOutcome<T>;
    try {
      outcome = { ok: true, value: await run(attempt) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const delayMs = options.delayFor(outcome, attempt);
    if (delayMs === null) {
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }
    await wait(delayMs, options.signal);
  }
}

export interface PollUntilOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Checked before every probe; a true result fails the wait immediately. */
  aborted?: () => boolean;
  signal?: AbortSignal;
  /** Injected by tests that must not really wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Re-run `probe` until it resolves (a throw means "not yet") or `timeoutMs`
 * elapses, returning what it resolved with. The last failure rides on the
 * timeout error's `cause`, so a wait that never succeeds says why.
 */
export async function pollUntil<T>(
  label: string,
  probe: () => Promise<T>,
  {
    timeoutMs = 60_000,
    intervalMs = 200,
    aborted = () => false,
    signal,
    sleep: wait = sleep,
  }: PollUntilOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    if (aborted()) throw new Error(`${label} wait aborted`);
    try {
      return await probe();
    } catch (error) {
      failure = error;
      await wait(intervalMs, signal);
    }
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: failure });
}
