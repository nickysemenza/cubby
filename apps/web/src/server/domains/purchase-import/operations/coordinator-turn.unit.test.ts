import { afterEach, describe, expect, it, vi } from "vitest";

import { COORDINATOR_TURN_LEASE_MS } from "./coordinator-gate";
import {
  CoordinatorLeaseLostError,
  CoordinatorTurn,
  type CoordinatorTurnPorts,
  coordinatorTurnBackoffMs,
} from "./coordinator-turn";

const granted = async () => ({
  held: true as const,
  leaseUntil: Date.now() + COORDINATOR_TURN_LEASE_MS,
});

const ports = (overrides: Partial<CoordinatorTurnPorts> = {}) => ({
  acquire: vi.fn<CoordinatorTurnPorts["acquire"]>(granted),
  release: vi.fn<CoordinatorTurnPorts["release"]>(async () => undefined),
  idle: vi.fn<CoordinatorTurnPorts["idle"]>(async () => true),
  reportIdleError: vi.fn<CoordinatorTurnPorts["reportIdleError"]>(),
  ...overrides,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("coordinator turn", () => {
  it("runs nothing without a turn and backs off with jitter", async () => {
    const refused = ports({
      acquire: vi.fn(async () => ({
        held: false as const,
        position: 3,
        holders: 6,
        waiting: 9,
      })),
    });
    const turns = new CoordinatorTurn(refused);
    const work = vi.fn(async () => "ran");
    const first = await turns.turn(work);
    const second = await turns.turn(work);
    expect(work).not.toHaveBeenCalled();
    expect(refused.release).not.toHaveBeenCalled();
    expect(first).toMatchObject({ ran: false, position: 3, holders: 6 });
    if (first.ran || second.ran) throw new Error("Expected refusals");
    expect(first.retryAfterMs).toBeGreaterThanOrEqual(7_500);
    expect(first.retryAfterMs).toBeLessThanOrEqual(22_500);
    expect(second.retryAfterMs).toBeGreaterThanOrEqual(15_000);
    expect(coordinatorTurnBackoffMs(20, () => 1)).toBe(450_000);
  });

  it("keeps the turn while pi works and releases it once idle, even after a throw", async () => {
    let working = true;
    const acquire = vi.fn<CoordinatorTurnPorts["acquire"]>(granted);
    const held = ports({ acquire, idle: vi.fn(async () => !working) });
    const turns = new CoordinatorTurn(held);
    expect(await turns.turn(async () => "submitted")).toEqual({
      ran: true,
      value: "submitted",
    });
    expect(held.release).not.toHaveBeenCalled();
    working = false;
    await expect(
      turns.turn(async () => {
        throw new Error("Synthetic alarm failure");
      }),
    ).rejects.toThrow("Synthetic alarm failure");
    expect(held.release).toHaveBeenCalledTimes(1);
    // One instance holds one token: every entry renews the same turn.
    expect(new Set(acquire.mock.calls.map(([token]) => token)).size).toBe(1);
  });

  it("keeps the turn when idleness cannot be decided, and reports why", async () => {
    const failure = new Error("Synthetic pi inspection failure");
    const unknown = ports({ idle: vi.fn(() => Promise.reject(failure)) });
    await new CoordinatorTurn(unknown).turn(async () => "ran");
    expect(unknown.release).not.toHaveBeenCalled();
    expect(unknown.reportIdleError).toHaveBeenCalledWith(failure);
  });

  // Review regression (Sol, #3917): entry A finishes and awaits its idle check;
  // entry B is admitted under the same token and starts working; A's late
  // "idle" must not release the turn B now works under.
  it("never releases a turn while a later entry works under it", async () => {
    const events: string[] = [];
    const idleCheck = Promise.withResolvers<boolean>();
    const turns = new CoordinatorTurn(
      ports({
        acquire: vi.fn(async () => {
          events.push("acquire");
          return granted();
        }),
        release: vi.fn(async () => {
          events.push("release");
        }),
        idle: vi.fn(() => idleCheck.promise),
      }),
    );
    const a = turns.turn(async () => "a");
    await tick();
    const bDone = Promise.withResolvers<void>();
    const b = turns.turn(async () => {
      events.push("b-start");
      await bDone.promise;
      events.push("b-end");
      return "b";
    });
    await tick();
    idleCheck.resolve(true);
    await a;
    await tick();
    bDone.resolve();
    await b;
    const start = events.indexOf("b-start");
    expect(events[start - 1]).toBe("acquire");
    expect(events.slice(start, events.indexOf("b-end"))).not.toContain(
      "release",
    );
  });

  it("fences database work: renews a lease nearing its end and refuses once it is lost", async () => {
    vi.useFakeTimers();
    let held = true;
    const acquire = vi.fn<CoordinatorTurnPorts["acquire"]>(async () =>
      held ? granted() : { held: false, position: 1, holders: 6, waiting: 1 },
    );
    const turns = new CoordinatorTurn(
      ports({ acquire, idle: vi.fn(async () => false) }),
    );
    await turns.turn(async () => "started");
    await expect(turns.fence()).resolves.toBeUndefined();
    expect(acquire).toHaveBeenCalledTimes(1);
    // Past half the lease, database work renews first.
    await vi.advanceTimersByTimeAsync(COORDINATOR_TURN_LEASE_MS / 2);
    await expect(turns.fence()).resolves.toBeUndefined();
    expect(acquire.mock.calls.length).toBeGreaterThan(1);
    // The gate re-grants nothing: the lease is lost and new work refused.
    held = false;
    await vi.advanceTimersByTimeAsync(COORDINATOR_TURN_LEASE_MS);
    await expect(turns.fence()).rejects.toBeInstanceOf(
      CoordinatorLeaseLostError,
    );
    await expect(turns.fence()).rejects.toBeInstanceOf(
      CoordinatorLeaseLostError,
    );
  });
});
