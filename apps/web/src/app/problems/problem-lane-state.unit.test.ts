import { describe, expect, it } from "vitest";
import type { ProblemExecutionLane } from "~/entities/problem-query";
import {
  type ProblemLaneState,
  problemSectionLaneState,
} from "./problem-lane-state";

const ready = (): ProblemLaneState => ({
  loaded: true,
  isLoading: false,
  error: null,
});

const states = (
  overrides: Partial<Record<ProblemExecutionLane, ProblemLaneState>> = {},
) =>
  ({
    fast: ready(),
    views: ready(),
    coverage: ready(),
    upc: ready(),
    tracker: ready(),
    ...overrides,
  }) satisfies Record<ProblemExecutionLane, ProblemLaneState>;

describe("problemSectionLaneState", () => {
  it("reveals a completed DB section while an external lane is still loading", () => {
    const laneStates = states({
      upc: { loaded: false, isLoading: true, error: null },
    });

    expect(
      problemSectionLaneState(["productsWithNoImages"], laneStates),
    ).toEqual({ state: "ready" });
    expect(
      problemSectionLaneState(["productsWithBetterUpcData"], laneStates),
    ).toEqual({ state: "loading" });
  });

  it("contains an external error to sections owned by that lane", () => {
    const externalError = new Error("provider unavailable");
    const laneStates = states({
      upc: { loaded: false, isLoading: false, error: externalError },
    });

    expect(
      problemSectionLaneState(["productsWithNoImages"], laneStates),
    ).toEqual({ state: "ready" });
    expect(
      problemSectionLaneState(["productsWithBetterUpcData"], laneStates),
    ).toEqual({ state: "error", error: externalError });
  });
});
