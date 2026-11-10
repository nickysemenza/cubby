/**
 * A coordinator's side of the household turn cap (`./coordinator-gate.ts`).
 * Every entry point that loads the agent (alarm, dispatch, a member prompt)
 * runs inside `turn`: it takes or renews the Run's turn first and, when none
 * is free, runs nothing and reports how long to wait; so does an entry whose
 * gate cannot be reached. pi keeps working in memory after an entry returns,
 * so the turn is kept until pi is confirmed idle. An idle check that fails
 * keeps it too, but only while fewer than `UNKNOWN_IDLE_LIMIT` checks in a
 * row, spanning at least two heartbeats, were undecidable: the turn is
 * then no longer renewed, database work stops at its current deadline, and
 * the coordinator asks again only after the gate's lease plus grace.
 *
 * All bookkeeping (acquire, renew, idle check, release) runs one step at a
 * time on this instance, so a release decided by one entry can never land
 * after another entry was admitted under the same token. Database work pi
 * starts passes `fence`: it renews a lease nearing its end and refuses once
 * the lease is lost, so a coordinator that lost its turn starts no new work.
 */
import type { UnparsedError } from "~/lib/error-utils";

import {
  COORDINATOR_TURN_GRACE_MS,
  COORDINATOR_TURN_LEASE_MS,
} from "./coordinator-gate";
import type { CoordinatorTurnGrant } from "./coordinator-gate-rpc";

export type CoordinatorTurnPorts = {
  acquire(
    token: string,
    options?: { queue: boolean },
  ): Promise<CoordinatorTurnGrant>;
  release(token: string): Promise<void>;
  /** Whether pi has no work running; throws when that cannot be decided. */
  idle(): Promise<boolean>;
  reportIdleError(error: UnparsedError): void;
  /** The gate did not answer; the entry waits as if refused. */
  reportGateError(error: UnparsedError): void;
};

export type CoordinatorTurnResult<T> =
  | { ran: true; value: T }
  | {
      ran: false;
      position: number;
      holders: number;
      retryAfterMs: number;
      /** The gate could not be asked (or this coordinator is letting its turn lapse). */
      unavailable?: true;
    };

/** Raised by `fence`; the message reads as transient to settlement. */
export class CoordinatorLeaseLostError extends Error {
  constructor() {
    super(
      "Coordinator turn lease lost: database work is temporarily unavailable until this coordinator holds a turn again",
    );
  }
}

const FIRST_WAIT_MS = 15_000;
const LONGEST_WAIT_MS = 5 * 60_000;
/** Local lease ends this much before the gate's, for clock skew and RPC time. */
const LEASE_SAFETY_MS = 30_000;
/** Renew while pi works, well inside the lease. */
const HEARTBEAT_MS = COORDINATOR_TURN_LEASE_MS / 3;
/**
 * Consecutive undecidable idle checks, over at least this span, before the
 * turn stops being renewed; quick entries alone never stop it.
 */
const UNKNOWN_IDLE_LIMIT = 3;
const UNKNOWN_IDLE_SPAN_MS = 2 * HEARTBEAT_MS;

/** Doubling from 15 s to 5 min, jittered ±50% so waiting coordinators spread out. */
export const coordinatorTurnBackoffMs = (waits: number, random = Math.random) =>
  Math.round(
    Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** Math.max(0, waits - 1)) *
      (0.5 + random()),
  );

export class CoordinatorTurn {
  /** One per object instance; a restarted instance renews the Run's turn. */
  private readonly token = crypto.randomUUID();
  private running = 0;
  private waits = 0;
  /** Local lease deadline; 0 while no turn is held. */
  private leaseUntil = 0;
  /** The gate's own deadline for the last grant. */
  private gateLeaseUntil = 0;
  private unknownIdleChecks = 0;
  /** When the current run of undecidable idle checks began. */
  private unknownIdleSince = 0;
  /**
   * Set once idleness stayed undecidable: no renewals and no new admissions
   * until the gate's lease plus grace has passed and it reclaimed the slot.
   */
  private lapsingUntil = 0;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private steps: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: CoordinatorTurnPorts) {}

  /** `queue: false` asks once without joining the gate's queue (a member prompt). */
  async turn<T>(
    work: () => Promise<T>,
    { queue = true }: { queue?: boolean } = {},
  ): Promise<CoordinatorTurnResult<T>> {
    const refused = await this.step(async () => {
      if (this.lapsing())
        return {
          ran: false as const,
          position: 0,
          holders: 0,
          retryAfterMs: Math.max(1_000, this.lapsingUntil - Date.now()),
          unavailable: true as const,
        };
      let grant: CoordinatorTurnGrant;
      try {
        grant = await this.renew(queue);
      } catch (error) {
        // An unreachable gate is a wait like a full one, never a failure.
        this.ports.reportGateError(error);
        this.waits++;
        return {
          ran: false as const,
          position: 0,
          holders: 0,
          retryAfterMs: coordinatorTurnBackoffMs(this.waits),
          unavailable: true as const,
        };
      }
      if (!grant.held) {
        this.waits++;
        return {
          ran: false as const,
          position: grant.position,
          holders: grant.holders,
          retryAfterMs: coordinatorTurnBackoffMs(this.waits),
        };
      }
      this.waits = 0;
      this.running++;
      return undefined;
    });
    if (refused) return refused;
    try {
      return { ran: true, value: await work() };
    } finally {
      await this.step(async () => {
        this.running--;
        await this.releaseIfIdle();
      });
    }
  }

  /** Before pi's database work: renew a lease nearing its end; refuse once it is lost. */
  fence(): Promise<void> {
    return this.step(async () => {
      if (this.leaseUntil === 0) throw new CoordinatorLeaseLostError();
      if (this.lapsing()) {
        // No renewal: work continues only until the current deadline.
        if (Date.now() < this.leaseUntil) return;
        this.leaseUntil = 0;
        throw new CoordinatorLeaseLostError();
      }
      if (Date.now() < this.leaseUntil - COORDINATOR_TURN_LEASE_MS / 2) return;
      const renewed = await this.renew().catch(() => undefined);
      // A failed renewal still allows work inside the lease already granted.
      if (!renewed && Date.now() < this.leaseUntil) return;
      if (!renewed?.held) {
        this.leaseUntil = 0;
        throw new CoordinatorLeaseLostError();
      }
    });
  }

  /** Run one bookkeeping step after every earlier one settles. */
  private step<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.steps.then(fn, fn);
    this.steps = run.catch(() => undefined);
    return run;
  }

  private async renew(queue = true): Promise<CoordinatorTurnGrant> {
    const asked = Date.now();
    const grant = await (queue
      ? this.ports.acquire(this.token)
      : this.ports.acquire(this.token, { queue }));
    if (grant.held) {
      this.leaseUntil = asked + COORDINATOR_TURN_LEASE_MS - LEASE_SAFETY_MS;
      this.gateLeaseUntil = grant.leaseUntil;
      this.beat();
    } else this.stop();
    return grant;
  }

  /**
   * Called inside a step. An undecidable idle check keeps the turn, but only
   * a bounded number of times: then the turn stops being renewed and lapses.
   */
  private async releaseIfIdle() {
    if (this.running > 0 || this.leaseUntil === 0 || this.lapsing()) return;
    const state = await this.ports.idle().then(
      (idle) => (idle ? ("idle" as const) : ("working" as const)),
      (error: UnparsedError) => {
        this.ports.reportIdleError(error);
        return "unknown" as const;
      },
    );
    if (state === "unknown") {
      if (this.unknownIdleChecks++ === 0) this.unknownIdleSince = Date.now();
      if (
        this.unknownIdleChecks >= UNKNOWN_IDLE_LIMIT &&
        Date.now() - this.unknownIdleSince >= UNKNOWN_IDLE_SPAN_MS
      )
        this.lapse();
      return;
    }
    this.unknownIdleChecks = 0;
    if (state === "working") return;
    this.stop();
    // SILENT: the port logs a failed release and the turn's lease lapses;
    // it must not replace the entry's own result or error.
    await this.ports.release(this.token).catch(() => undefined);
  }

  /** While a turn is held, renew it (or release it once pi is idle) on a timer. */
  private beat() {
    if (this.heartbeat !== undefined) return;
    this.heartbeat = setTimeout(() => {
      this.heartbeat = undefined;
      void this.step(async () => {
        if (this.leaseUntil === 0) return;
        await this.releaseIfIdle();
        if (this.leaseUntil === 0 || this.lapsing()) return;
        // An unreachable gate leaves the lease to lapse; `fence` stops new work then.
        await this.renew().catch(() => {
          // SILENT: a failed renewal retries on the next beat; `fence` refuses
          // new database work once the local lease has passed.
          this.beat();
        });
      }).catch(() => {
        // SILENT: each step reports its own failures through the ports.
      });
    }, HEARTBEAT_MS);
  }

  /**
   * Stop extending a turn whose idleness cannot be decided: keep the current
   * deadline (`fence` refuses database work after it) and admit nothing until
   * the gate's lease plus grace passed and the gate reclaimed the slot.
   */
  private lapse() {
    this.lapsingUntil = this.gateLeaseUntil + COORDINATOR_TURN_GRACE_MS;
    if (this.heartbeat !== undefined) clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
  }

  /** Whether the turn is lapsing; once the gate reclaimed it, start afresh. */
  private lapsing() {
    if (this.lapsingUntil === 0) return false;
    if (Date.now() < this.lapsingUntil) return true;
    this.lapsingUntil = 0;
    this.unknownIdleChecks = 0;
    this.leaseUntil = 0;
    return false;
  }

  private stop() {
    this.leaseUntil = 0;
    if (this.heartbeat !== undefined) clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
  }
}
