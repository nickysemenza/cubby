/**
 * The household coordinator-turn queue, held by the singleton
 * `CoordinatorGateDurableObject` (docs/infrastructure.md#background-connection-budget).
 * Pure state over an injected clock so its ordering rules are testable:
 *
 * - At most `cap` Runs hold a turn. A holder renews by asking again; its turn
 *   lapses at `leaseUntil`, and the slot is re-granted only after a further
 *   grace period, so a holder that lost its lease has stopped before another
 *   takes its place.
 * - Every refused Run waits in one FIFO list, keeping its place across polls.
 *   A freed slot is reserved for the first eligible waiter and that waiter is
 *   notified; a later waiter overtakes it only while it leaves a reservation
 *   unclaimed, until it asks again or its entry lapses unpolled.
 */

import type {
  CoordinatorGateRequest,
  CoordinatorGateStatus,
  CoordinatorTurnGrant,
} from "./coordinator-gate-rpc";

/** Concurrent coordinator turns (2 sockets each; see the budget). */
const COORDINATOR_TURN_CAP = 6;
/** Renewed on every coordinator entry and while pi works. */
export const COORDINATOR_TURN_LEASE_MS = 10 * 60_000;
/** A lapsed holder's slot is not re-granted until this much later. */
export const COORDINATOR_TURN_GRACE_MS = 5 * 60_000;
/** How long a freed slot waits for the waiter it was reserved for. */
const RESERVATION_MS = 60_000;
/** A waiter that stops asking (its coordinator gave up or died) leaves the list. */
const WAITER_TTL_MS = 15 * 60_000;

type Holder = {
  runId: string;
  /** The coordinator object's name, to notify it. */
  agent: string;
  token: string;
  leaseUntil: number;
  /** When the turn was granted; renewals keep it. Absent on state persisted before it existed. */
  heldSince?: number;
};
type Waiter = {
  runId: string;
  agent: string;
  since: number;
  seenAt: number;
  reservedUntil: number | null;
  /** When it last left a reservation unclaimed; ineligible until it asks again. */
  passedAt: number | null;
};

export type CoordinatorGateState = { holders: Holder[]; waiters: Waiter[] };

/** A gate decision and the coordinators newly reserved a slot, to wake. */
export type CoordinatorGateAcquired = {
  grant: CoordinatorTurnGrant;
  notify: string[];
};
export type CoordinatorGateReleased = { released: boolean; notify: string[] };
export type CoordinatorGateRead = {
  status: CoordinatorGateStatus;
  notify: string[];
};

export class CoordinatorGateQueue {
  constructor(
    readonly state: CoordinatorGateState = { holders: [], waiters: [] },
    private readonly cap = COORDINATOR_TURN_CAP,
  ) {}

  /** Take, renew or wait for a turn; `notify` names coordinators granted a reservation. */
  acquire(
    request: CoordinatorGateRequest,
    now: number,
  ): CoordinatorGateAcquired {
    this.prune(now);
    const holder = this.state.holders.find(
      (entry) => entry.runId === request.runId,
    );
    if (holder) {
      holder.token = request.token;
      holder.agent = request.agent;
      holder.leaseUntil = now + COORDINATOR_TURN_LEASE_MS;
      // Pruning may have freed another holder's lapsed slot.
      return {
        grant: { held: true, leaseUntil: holder.leaseUntil },
        notify: this.reserve(now),
      };
    }
    let waiter = this.state.waiters.find(
      (entry) => entry.runId === request.runId,
    );
    // A caller that will not wait (a member prompt) takes a turn only when one
    // is free beyond every reservation, and otherwise leaves no entry behind.
    if (!waiter && request.queue === false) {
      const notify = this.reserve(now);
      const reserved = this.state.waiters.filter(
        (entry) => entry.reservedUntil !== null,
      ).length;
      if (this.state.holders.length + reserved < this.cap) {
        const leaseUntil = now + COORDINATOR_TURN_LEASE_MS;
        this.state.holders.push({
          runId: request.runId,
          agent: request.agent,
          token: request.token,
          leaseUntil,
          heldSince: now,
        });
        return { grant: { held: true, leaseUntil }, notify };
      }
      return {
        grant: {
          held: false,
          position: 0,
          holders: this.state.holders.length,
          waiting: this.state.waiters.length,
        },
        notify,
      };
    }
    if (!waiter) {
      waiter = {
        runId: request.runId,
        agent: request.agent,
        since: now,
        seenAt: now,
        reservedUntil: null,
        passedAt: null,
      };
      this.state.waiters.push(waiter);
    }
    waiter.seenAt = now;
    waiter.agent = request.agent;
    const notify = this.reserve(now);
    // A reservation is a slot already counted against the cap; admission
    // converts it to a holder and re-checks the cap all the same.
    if (waiter.reservedUntil !== null && this.state.holders.length < this.cap) {
      this.state.waiters = this.state.waiters.filter(
        (entry) => entry !== waiter,
      );
      const leaseUntil = now + COORDINATOR_TURN_LEASE_MS;
      this.state.holders.push({
        runId: request.runId,
        agent: request.agent,
        token: request.token,
        leaseUntil,
        heldSince: now,
      });
      return {
        grant: { held: true, leaseUntil },
        notify: notify.filter((agent) => agent !== request.agent),
      };
    }
    return {
      grant: {
        held: false,
        position: this.state.waiters.indexOf(waiter) + 1,
        holders: this.state.holders.length,
        waiting: this.state.waiters.length,
      },
      notify,
    };
  }

  /** Release a turn `token` still holds; the freed slot is reserved for the next waiter. */
  release(
    request: Omit<CoordinatorGateRequest, "agent">,
    now: number,
  ): CoordinatorGateReleased {
    this.prune(now);
    const before = this.state.holders.length;
    this.state.holders = this.state.holders.filter(
      (entry) => entry.runId !== request.runId || entry.token !== request.token,
    );
    const released = this.state.holders.length < before;
    return { released, notify: this.reserve(now) };
  }

  /** The gate's alarm: reclaim lapsed turns and reservations, reserve freed slots. */
  tick(now: number): string[] {
    this.prune(now);
    return this.reserve(now);
  }

  /**
   * Runs holding or waiting for a turn now. Both are alive: a holder until
   * its lease plus grace lapses, a waiter until it stops asking.
   */
  status(now: number): CoordinatorGateRead {
    this.prune(now);
    const notify = this.reserve(now);
    return {
      status: {
        // Only a recently granted holder is reported: it covers the gap before
        // its first heartbeat, while a holder hung for longer than lease plus
        // grace stays subject to stale-Run expiry.
        holders: this.state.holders
          .filter(
            (entry) =>
              now - (entry.heldSince ?? 0) <
              COORDINATOR_TURN_LEASE_MS + COORDINATOR_TURN_GRACE_MS,
          )
          .map((entry) => entry.runId),
        waiting: this.state.waiters.map((entry) => entry.runId),
      },
      notify,
    };
  }

  /** When a lease, grace, reservation or waiter entry next lapses. */
  nextChangeAt(): number | null {
    const times = [
      ...this.state.holders.map(
        (entry) => entry.leaseUntil + COORDINATOR_TURN_GRACE_MS,
      ),
      ...this.state.waiters.flatMap((entry) => [
        entry.seenAt + WAITER_TTL_MS,
        ...(entry.reservedUntil === null ? [] : [entry.reservedUntil]),
      ]),
    ];
    return times.length ? Math.min(...times) : null;
  }

  private prune(now: number) {
    this.state.holders = this.state.holders.filter(
      (entry) => entry.leaseUntil + COORDINATOR_TURN_GRACE_MS > now,
    );
    this.state.waiters = this.state.waiters.filter(
      (entry) => entry.seenAt + WAITER_TTL_MS > now,
    );
    for (const entry of this.state.waiters)
      if (entry.reservedUntil !== null && entry.reservedUntil <= now) {
        // Passed over as of the lapse, so its own ask after it still counts.
        entry.passedAt = entry.reservedUntil;
        entry.reservedUntil = null;
      }
  }

  /**
   * Reserve each free slot for the first eligible waiter without one, in
   * order. Every live reservation already holds a slot, wherever its waiter
   * stands, so holders plus reservations never exceed the cap; an earlier
   * waiter that becomes eligible again waits for the next free slot.
   */
  private reserve(now: number): string[] {
    let free =
      this.cap -
      this.state.holders.length -
      this.state.waiters.filter((entry) => entry.reservedUntil !== null).length;
    const notify: string[] = [];
    for (const entry of this.state.waiters) {
      if (free <= 0) break;
      if (entry.reservedUntil !== null) continue;
      // Passed over: eligible again once it asks after the lapse.
      if (entry.passedAt !== null && entry.seenAt <= entry.passedAt) continue;
      entry.reservedUntil = now + RESERVATION_MS;
      entry.passedAt = null;
      notify.push(entry.agent);
      free--;
    }
    return notify;
  }
}

/** The one gate instance's name. */
export const COORDINATOR_GATE_NAME = "household";
