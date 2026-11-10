import { describe, expect, it } from "vitest";

import {
  COORDINATOR_TURN_GRACE_MS,
  COORDINATOR_TURN_LEASE_MS,
  CoordinatorGateQueue,
} from "./coordinator-gate";

const ask = (gate: CoordinatorGateQueue, run: string, now: number) =>
  gate.acquire(
    { runId: run, agent: `agent-${run}`, token: `token-${run}` },
    now,
  );

describe("coordinator gate", () => {
  it("grants at most the cap, queues the rest in order and keeps each place across polls", () => {
    const gate = new CoordinatorGateQueue(undefined, 2);
    expect(ask(gate, "a", 0).grant.held).toBe(true);
    expect(ask(gate, "b", 0).grant.held).toBe(true);
    expect(ask(gate, "c", 1).grant).toMatchObject({ held: false, position: 1 });
    expect(ask(gate, "d", 2).grant).toMatchObject({ held: false, position: 2 });
    // Polling again keeps the place; a holder renews without a second turn.
    expect(ask(gate, "d", 3).grant).toMatchObject({ held: false, position: 2 });
    expect(ask(gate, "c", 4).grant).toMatchObject({ held: false, position: 1 });
    expect(ask(gate, "a", 5).grant.held).toBe(true);
    expect(gate.state.holders).toHaveLength(2);
    expect(gate.status(6).status).toEqual({
      holders: ["a", "b"],
      waiting: ["c", "d"],
    });
  });

  it("reserves a freed slot for the head of the queue and wakes it", () => {
    const gate = new CoordinatorGateQueue(undefined, 1);
    ask(gate, "a", 0);
    ask(gate, "b", 1);
    ask(gate, "c", 2);
    expect(gate.release({ runId: "a", token: "token-a" }, 3)).toEqual({
      released: true,
      notify: ["agent-b"],
    });
    // The later waiter cannot take the slot reserved for the head.
    expect(ask(gate, "c", 4).grant).toMatchObject({ held: false, position: 2 });
    expect(ask(gate, "b", 5).grant.held).toBe(true);
    // A stale token releases nothing.
    expect(gate.release({ runId: "b", token: "token-a" }, 6).released).toBe(
      false,
    );
  });

  it("lets a later waiter overtake only while the head leaves its reservation unclaimed", () => {
    const gate = new CoordinatorGateQueue(undefined, 1);
    ask(gate, "a", 0);
    ask(gate, "b", 1);
    ask(gate, "c", 2);
    gate.release({ runId: "a", token: "token-a" }, 10);
    // b never claims within the reservation: c is woken and overtakes.
    expect(gate.tick(10 + 60_001)).toEqual(["agent-c"]);
    expect(ask(gate, "c", 10 + 60_002).grant.held).toBe(true);
    // b keeps its place at the head and is next once it asks again.
    expect(ask(gate, "b", 10 + 70_000).grant).toMatchObject({
      held: false,
      position: 1,
    });
    gate.release({ runId: "c", token: "token-c" }, 10 + 80_000);
    expect(ask(gate, "b", 10 + 80_001).grant.held).toBe(true);
  });

  it("re-grants a lapsed turn only after its lease and grace, and lets the holder renew within grace", () => {
    const gate = new CoordinatorGateQueue(undefined, 1);
    ask(gate, "a", 0);
    const lapsed = COORDINATOR_TURN_LEASE_MS + 1;
    expect(ask(gate, "b", lapsed).grant.held).toBe(false);
    // Within grace the slot is still a's: it renews, and b still waits.
    expect(ask(gate, "a", lapsed + 1).grant).toEqual({
      held: true,
      leaseUntil: lapsed + 1 + COORDINATOR_TURN_LEASE_MS,
    });
    const gone =
      lapsed + 1 + COORDINATOR_TURN_LEASE_MS + COORDINATOR_TURN_GRACE_MS;
    expect(ask(gate, "b", gone - 1).grant.held).toBe(false);
    expect(gate.tick(gone)).toEqual(["agent-b"]);
    expect(ask(gate, "b", gone + 1).grant.held).toBe(true);
    // The lapsed holder asks again and waits like anyone else.
    expect(ask(gate, "a", gone + 2).grant).toMatchObject({ held: false });
  });

  it("drops a waiter that stops asking", () => {
    const gate = new CoordinatorGateQueue(undefined, 1);
    ask(gate, "a", 0);
    ask(gate, "b", 1);
    expect(gate.status(15 * 60_000).status.waiting).toEqual(["b"]);
    expect(gate.status(15 * 60_000 + 2).status.waiting).toEqual([]);
  });

  // Review regression (Sol, #3927): a passed-over head that asks again must
  // not take a fresh reservation while a later waiter's is still live.
  it("never lets holders and live reservations exceed the cap", () => {
    const gate = new CoordinatorGateQueue(undefined, 1);
    const holders = () => gate.state.holders.length;
    ask(gate, "a", 0);
    ask(gate, "b", 1);
    ask(gate, "c", 2);
    gate.release({ runId: "a", token: "token-a" }, 10);
    // b's reservation lapses unclaimed; c is reserved.
    expect(gate.tick(10 + 60_001)).toEqual(["agent-c"]);
    // b asks again while c's reservation is live: b waits.
    expect(ask(gate, "b", 10 + 60_002).grant).toMatchObject({
      held: false,
      position: 1,
    });
    expect(holders()).toBe(0);
    // c claims its reservation.
    expect(ask(gate, "c", 10 + 60_003).grant.held).toBe(true);
    expect(holders()).toBe(1);
    // b is next once c releases.
    expect(
      gate.release({ runId: "c", token: "token-c" }, 10 + 60_004).notify,
    ).toEqual(["agent-b"]);
    expect(ask(gate, "b", 10 + 60_005).grant.held).toBe(true);
    expect(holders()).toBe(1);
  });

  it("still grants a waiter that asks just after its own reservation lapsed", () => {
    const gate = new CoordinatorGateQueue(undefined, 1);
    ask(gate, "a", 0);
    ask(gate, "b", 1);
    gate.release({ runId: "a", token: "token-a" }, 10);
    // Nothing pruned in between: b's own late ask finds the slot free.
    expect(ask(gate, "b", 10 + 60_001).grant.held).toBe(true);
  });

  it("reserves capacity a lapsed holder frees, whichever call notices it", () => {
    const gate = new CoordinatorGateQueue(undefined, 2);
    ask(gate, "a", 0);
    ask(gate, "b", 0);
    ask(gate, "c", 1);
    const half = COORDINATOR_TURN_LEASE_MS / 2;
    ask(gate, "b", half);
    ask(gate, "c", half);
    const lapsed = COORDINATOR_TURN_LEASE_MS + COORDINATOR_TURN_GRACE_MS + 1;
    // b renews; a's lapse frees a slot, reserved for c and woken.
    expect(ask(gate, "b", lapsed).notify).toEqual(["agent-c"]);
  });

  it("lets a caller that will not wait take only a truly free turn, leaving no queue entry", () => {
    const gate = new CoordinatorGateQueue(undefined, 1);
    const prompt = (run: string, now: number) =>
      gate.acquire(
        {
          runId: run,
          agent: `agent-${run}`,
          token: `token-${run}`,
          queue: false,
        },
        now,
      );
    expect(prompt("a", 0).grant.held).toBe(true);
    expect(prompt("b", 1).grant).toMatchObject({ held: false, position: 0 });
    expect(gate.state.waiters).toEqual([]);
    // A freed slot reserved for a queued waiter is not free for a prompt.
    ask(gate, "c", 2);
    gate.release({ runId: "a", token: "token-a" }, 3);
    expect(prompt("b", 4).grant.held).toBe(false);
    expect(gate.status(5).status).toEqual({ holders: [], waiting: ["c"] });
  });
});
