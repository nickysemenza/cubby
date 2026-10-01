import type { InfLocation } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import binPlanVectors from "@cubby/shared/golden-vectors/bin-plan.json";
import { describe, expect, it } from "vitest";

import {
  canGoMissing,
  planSweptBin,
  type SweepBinNode,
  type SweepBinVerdict,
} from "./sweep-bin-plan";

const at = (
  code: string,
  name: string,
  parent?: SweepBinNode,
): SweepBinNode => ({
  id: testShortcode("location", code),
  name,
  parent,
});

/** Home — the one live parentless location. */
const home = at("LOC-HOME", "Home");
const garage = at("LOC-GRGE", "Garage", home);
const shelf = at("LOC-SHLF", "Shelf A", garage);
const binOnShelf = at("LOC-BIN1", "Bin 1", shelf);

describe("planSweptBin", () => {
  it("confirms a direct child", () => {
    expect(planSweptBin(shelf, binOnShelf)).toEqual({ kind: "confirm" });
  });

  /**
   * The sharpest edge of the direct-membership rule: a bin one level deeper is
   * NOT here. Promoting it is legal — moving a descendant under its own
   * ancestor makes no cycle — so it is offered rather than refused.
   */
  it("offers a grandchild for promotion rather than confirming it", () => {
    const inner = at("LOC-BIN2", "Bin 2", binOnShelf);
    expect(planSweptBin(shelf, inner)).toEqual({
      kind: "adopt",
      bin: {
        id: testShortcode("location", "LOC-BIN2"),
        name: "Bin 2",
        type: null,
        currentParentName: "Bin 1",
      },
    });
  });

  it("offers a bin from another branch, naming where it sits now", () => {
    const stray = at("LOC-BIN9", "Bin 9", at("LOC-KTCH", "Kitchen", home));
    expect(planSweptBin(shelf, stray)).toEqual({
      kind: "adopt",
      bin: {
        id: testShortcode("location", "LOC-BIN9"),
        name: "Bin 9",
        type: null,
        currentParentName: "Kitchen",
      },
    });
  });

  it("refuses the location being swept", () => {
    expect(planSweptBin(shelf, shelf)).toMatchObject({
      kind: "refuse",
      reason: "self",
      message: "That's Shelf A — the one you're sweeping.",
    });
  });

  it("refuses the immediate parent as a cycle", () => {
    expect(planSweptBin(shelf, garage)).toMatchObject({
      kind: "refuse",
      reason: "ancestor",
      message: "Garage contains Shelf A — it can't move inside it.",
    });
  });

  it("refuses a grandparent, not just the immediate parent", () => {
    const deep = at("LOC-DEEP", "Deep", binOnShelf);
    expect(planSweptBin(deep, garage)).toMatchObject({
      kind: "refuse",
      reason: "ancestor",
      message: "Garage contains Deep — it can't move inside it.",
    });
  });

  /** Pins the check order: Home is an ancestor of nearly everything. */
  it("reports Home as Home even though it is also an ancestor", () => {
    expect(planSweptBin(shelf, home)).toMatchObject({
      kind: "refuse",
      reason: "home",
      message: "Home holds the whole house — it can't sit on a shelf.",
    });
  });

  it("lets Home itself be swept", () => {
    expect(planSweptBin(home, binOnShelf)).toMatchObject({ kind: "adopt" });
  });
});

const child = (type: InfLocation["type"]) => ({ type });

describe("canGoMissing", () => {
  it.each(["box", "bag"] as const)("counts the portable %s", (type) => {
    expect(canGoMissing(child(type))).toBe(true);
  });

  it("counts a product-identity bin, which is a vessel by definition", () => {
    expect(canGoMissing(child("furniture"))).toBe(true);
  });

  /**
   * The Husky tool cart: its drawers carry QR labels and are scannable, but
   * they cannot leave the cart, so a sweep must never report them gone.
   */
  it.each(["drawer", "cabinet", "shelf", "table", "cart"] as const)(
    "never reports the fixed %s as missing",
    (type) => {
      expect(canGoMissing(child(type))).toBe(false);
    },
  );

  it.each(["house", "room", "area"] as const)(
    "excludes the unscannable %s",
    (type) => {
      expect(canGoMissing(child(type))).toBe(false);
    },
  );
});

// Shared with apps/apple BinPlanTests (Audit/BinPlan.swift is a port of this
// module): the verdict, reason and copy must agree between the two.
describe("golden vectors", () => {
  const byCode = new Map<string, SweepBinNode>();
  const node = (code: string): SweepBinNode => {
    const existing = byCode.get(code);
    if (existing) return existing;
    const spec = binPlanVectors.nodes.find(
      (candidate) => candidate.code === code,
    );
    if (!spec) throw new Error(`unknown vector node ${code}`);
    const built = at(
      code,
      spec.name,
      spec.parent === null ? undefined : node(spec.parent),
    );
    byCode.set(code, built);
    return built;
  };

  // The vectors use the Swift reason vocabulary: `root` is TS `home`.
  const summarize = (verdict: SweepBinVerdict) => {
    switch (verdict.kind) {
      case "confirm":
        return { verdict: "confirm" };
      case "adopt":
        return {
          verdict: "adopt",
          adoptName: verdict.bin.name,
          currentParentName: verdict.bin.currentParentName,
        };
      case "refuse":
        return {
          verdict: "refuse",
          reason: verdict.reason === "home" ? "root" : verdict.reason,
          message: verdict.message,
        };
    }
  };

  it.each(binPlanVectors.cases)(
    "$anchor scans $scanned -> $verdict $reason",
    (vector) => {
      expect(
        summarize(planSweptBin(node(vector.anchor), node(vector.scanned))),
      ).toEqual({
        verdict: vector.verdict,
        reason: "reason" in vector ? vector.reason : undefined,
        message: vector.message?.replace("{verb}", "sweeping"),
        adoptName: "adoptName" in vector ? vector.adoptName : undefined,
        currentParentName:
          "currentParentName" in vector ? vector.currentParentName : undefined,
      });
    },
  );
});
