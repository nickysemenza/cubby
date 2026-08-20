import { describe, expect, it } from "vitest";
import { isUnbatchedTRPCPath } from "./problems-query-groups";

// Guards a load-bearing perf invariant: the hot Problems procedures must stay
// out of the tRPC batch link (batching them serialized 5 CPU-bound detectors
// into one request and blew the p99). If a hot path falls out of the unbatched
// set — or a cheap one is added — this catches it.
describe("isUnbatchedTRPCPath", () => {
  it("marks only the hot Problems paths as unbatched", () => {
    expect(isUnbatchedTRPCPath("problems.getFast")).toBe(true);
    expect(isUnbatchedTRPCPath("problems.getCoverage")).toBe(true);
    expect(isUnbatchedTRPCPath("problems.getUpc")).toBe(true);
    expect(isUnbatchedTRPCPath("problems.getCounts")).toBe(true);
    expect(isUnbatchedTRPCPath("problems.getMaintenanceCounts")).toBe(false);
    expect(isUnbatchedTRPCPath("recipe.list")).toBe(false);
  });
});
