import type { ProblemKey } from "@cubby/schemas/problems";
import type { ProblemExecutionLane } from "~/entities/problem-query";
import { problemQuery } from "~/entities/problem-registry";

export type ProblemLaneState = {
  loaded: boolean;
  isLoading: boolean;
  error: Error | null;
};

export type ProblemSectionLaneState =
  | { state: "ready" }
  | { state: "loading" }
  | { state: "error"; error: Error };

/** Resolve only the lanes owned by a section, so sibling failures stay local. */
export const problemSectionLaneState = (
  problemKeys: readonly ProblemKey[],
  laneStates: Record<ProblemExecutionLane, ProblemLaneState>,
): ProblemSectionLaneState => {
  const states = problemKeys.flatMap((key) => {
    const lane = problemQuery(key)?.executionLane;
    return lane ? [laneStates[lane]] : [];
  });
  const error = states.find((state) => state.error)?.error;
  if (error) return { state: "error", error };
  if (states.some((state) => !state.loaded)) return { state: "loading" };
  return { state: "ready" };
};
