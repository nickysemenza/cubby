import { describe, expect, it } from "vitest";
import {
  isUnbatchedTRPCPath,
  PROBLEMS_HOT_PATH_PROCEDURES,
  PROBLEMS_UNBATCHED_PATHS,
  problemsProcedurePath,
} from "./problems-query-groups";

describe("problems query groups", () => {
  it("pins the hot Problems procedures that must not batch", () => {
    expect(PROBLEMS_HOT_PATH_PROCEDURES).toEqual([
      "getFast",
      "getCoverage",
      "getUpc",
    ]);
    expect([...PROBLEMS_UNBATCHED_PATHS]).toEqual([
      "problems.getFast",
      "problems.getCoverage",
      "problems.getUpc",
    ]);
  });

  it("builds tRPC procedure paths from procedure names", () => {
    expect(problemsProcedurePath("getCoverage")).toBe("problems.getCoverage");
  });

  it("only marks hot Problems paths as unbatched", () => {
    expect(isUnbatchedTRPCPath("problems.getFast")).toBe(true);
    expect(isUnbatchedTRPCPath("problems.getMaintenanceCounts")).toBe(false);
    expect(isUnbatchedTRPCPath("recipe.list")).toBe(false);
  });
});
