/**
 * A coordinator's side of the household turn cap
 * (`domains/run/repo/coordinator-turns.ts`). Every entry point that loads the
 * agent (alarm, dispatch, a member prompt) runs inside `turn`: it takes or
 * renews the Run's turn first and, when none is free, runs nothing and reports
 * how long to wait. The turn is kept while pi still has work running, because
 * pi keeps working in memory after the entry point returns; the entry that
 * finds it idle releases it, including one that threw.
 */
export type CoordinatorTurnPorts = {
  hold(
    token: string,
  ): Promise<{ held: true } | { held: false; holders: number }>;
  release(token: string): Promise<void>;
  /** Whether the loaded agent has no work running; true when none is loaded. */
  idle(): Promise<boolean>;
};

export type CoordinatorTurnResult<T> =
  | { ran: true; value: T }
  | { ran: false; holders: number; retryAfterMs: number };

const FIRST_WAIT_MS = 15_000;
const LONGEST_WAIT_MS = 5 * 60_000;

/** Doubling from 15 s to 5 min, jittered ±50% so waiting coordinators spread out. */
export const coordinatorTurnBackoffMs = (waits: number, random = Math.random) =>
  Math.round(
    Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** Math.max(0, waits - 1)) *
      (0.5 + random()),
  );

export class CoordinatorTurn {
  /** One per object instance; a restarted instance renews the Run's row. */
  private readonly token = crypto.randomUUID();
  private running = 0;
  private waits = 0;

  constructor(private readonly ports: CoordinatorTurnPorts) {}

  async turn<T>(work: () => Promise<T>): Promise<CoordinatorTurnResult<T>> {
    const slot = await this.ports.hold(this.token);
    if (!slot.held) {
      this.waits++;
      return {
        ran: false,
        holders: slot.holders,
        retryAfterMs: coordinatorTurnBackoffMs(this.waits),
      };
    }
    this.waits = 0;
    this.running++;
    try {
      return { ran: true, value: await work() };
    } finally {
      this.running--;
      if (this.running === 0 && (await this.ports.idle().catch(() => true)))
        // SILENT: the port logs a failed release and the turn's lease lapses;
        // it must not replace the work's own result or error.
        await this.ports.release(this.token).catch(() => undefined);
    }
  }
}
