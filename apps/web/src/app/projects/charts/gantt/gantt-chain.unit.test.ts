import { describe, expect, it } from "vitest";
import { type ChainNode, longestChains } from "./gantt-chain";

function node(params: {
  id: string;
  startDay?: number | null;
  endDay?: number | null;
  blockedByIds?: string[];
}): ChainNode {
  return {
    id: params.id,
    startDay: params.startDay ?? null,
    endDay: params.endDay ?? null,
    blockedByIds: params.blockedByIds ?? [],
  };
}

describe("longestChains", () => {
  it("finds two separate components independently, sorted by workDays descending", () => {
    const a = node({ id: "a" });
    const b = node({ id: "b", blockedByIds: ["a"] });
    const c = node({ id: "c", blockedByIds: ["b"] });
    const x = node({ id: "x" });
    const y = node({ id: "y", blockedByIds: ["x"] });

    const chains = longestChains([a, b, c, x, y]);
    expect(chains).toHaveLength(2);
    expect(chains[0]?.ids).toEqual(["a", "b", "c"]);
    expect(chains[0]?.workDays).toBe(3);
    expect(chains[0]?.edges).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(chains[1]?.ids).toEqual(["x", "y"]);
    expect(chains[1]?.workDays).toBe(2);
  });

  it("never throws or loops forever on a cycle, and still returns a usable chain", () => {
    const a = node({ id: "a", blockedByIds: ["b"] });
    const b = node({ id: "b", blockedByIds: ["a"] });
    expect(() => longestChains([a, b])).not.toThrow();
    const chains = longestChains([a, b]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.ids.length).toBeGreaterThan(0);
    // Every id in the reconstructed chain must be one of the two real nodes.
    for (const id of chains[0]?.ids ?? []) {
      expect(["a", "b"]).toContain(id);
    }
  });

  it("computes elapsedDays < workDays for overlapping dependency dates", () => {
    const a = node({ id: "a", startDay: 0, endDay: 5 });
    const b = node({ id: "b", startDay: 2, endDay: 8, blockedByIds: ["a"] });
    const [chain] = longestChains([a, b]);
    expect(chain?.workDays).toBe(6 + 7);
    expect(chain?.elapsedDays).toBe(8 - 0 + 1); // 9, strictly less than workDays (13)
    expect(chain?.elapsedDays).toBeLessThan(chain?.workDays ?? 0);
  });

  it("treats an undated node as duration 1", () => {
    const a = node({ id: "a", startDay: 0, endDay: 0 }); // duration 1
    const b = node({ id: "b", blockedByIds: ["a"] }); // undated, duration 1
    const [chain] = longestChains([a, b]);
    expect(chain?.workDays).toBe(2);
    expect(chain?.elapsedDays).toBe(1);
  });

  it("falls back to elapsedDays === workDays when nothing in the chain is dated", () => {
    const a = node({ id: "a" });
    const b = node({ id: "b", blockedByIds: ["a"] });
    const [chain] = longestChains([a, b]);
    expect(chain?.elapsedDays).toBe(chain?.workDays);
  });

  it("breaks a tie between two equal-length paths deterministically", () => {
    const r = node({ id: "r" });
    const a = node({ id: "a", startDay: 0, endDay: 2, blockedByIds: ["r"] }); // duration 3
    const b = node({ id: "b", startDay: 0, endDay: 2, blockedByIds: ["r"] }); // duration 3
    const [chain] = longestChains([r, a, b]);
    expect(chain?.workDays).toBe(1 + 3);
    expect(chain?.ids).toEqual(["r", "a"]);
  });

  it("skips singleton components with no edges", () => {
    const isolated = node({ id: "isolated" });
    const a = node({ id: "a" });
    const b = node({ id: "b", blockedByIds: ["a"] });
    const chains = longestChains([isolated, a, b]);
    expect(chains).toHaveLength(1);
    expect(chains.some((c) => c.ids.includes("isolated"))).toBe(false);
  });

  it("ignores a blockedBy reference to a node outside the given set", () => {
    const a = node({ id: "a", blockedByIds: ["ghost"] });
    expect(() => longestChains([a])).not.toThrow();
    expect(longestChains([a])).toEqual([]);
  });
});
