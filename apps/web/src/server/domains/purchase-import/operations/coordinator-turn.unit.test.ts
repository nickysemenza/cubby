import { describe, expect, it, vi } from "vitest";

import {
  CoordinatorTurn,
  type CoordinatorTurnPorts,
  coordinatorTurnBackoffMs,
} from "./coordinator-turn";

const ports = (overrides: Partial<CoordinatorTurnPorts> = {}) => ({
  hold: vi.fn<CoordinatorTurnPorts["hold"]>(async () => ({ held: true })),
  release: vi.fn<CoordinatorTurnPorts["release"]>(async () => undefined),
  idle: vi.fn<CoordinatorTurnPorts["idle"]>(async () => true),
  ...overrides,
});

describe("coordinator turn", () => {
  it("runs nothing without a turn and backs off with jitter", async () => {
    const refused = ports({
      hold: vi.fn(async () => ({ held: false as const, holders: 6 })),
    });
    const turns = new CoordinatorTurn(refused);
    const work = vi.fn(async () => "ran");
    const first = await turns.turn(work);
    const second = await turns.turn(work);
    expect(work).not.toHaveBeenCalled();
    expect(refused.release).not.toHaveBeenCalled();
    expect(first).toMatchObject({ ran: false, holders: 6 });
    if (first.ran || second.ran) throw new Error("Expected refusals");
    expect(first.retryAfterMs).toBeGreaterThanOrEqual(7_500);
    expect(first.retryAfterMs).toBeLessThanOrEqual(22_500);
    expect(second.retryAfterMs).toBeGreaterThanOrEqual(15_000);
    expect(coordinatorTurnBackoffMs(20, () => 1)).toBe(450_000);
  });

  it("keeps the turn while pi works and releases it once idle, even after a throw", async () => {
    let working = true;
    const hold = vi.fn<CoordinatorTurnPorts["hold"]>(async () => ({
      held: true,
    }));
    const held = ports({ hold, idle: vi.fn(async () => !working) });
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
    expect(new Set(hold.mock.calls.map(([token]) => token)).size).toBe(1);
  });
});
