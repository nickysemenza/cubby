import { describe, expect, it } from "vitest";
import { classifyHttpWorkload, classifyTrpcWorkload } from "./workload";

describe("performance workload classification", () => {
  it.each([
    ["/", "ui"],
    ["/locations", "ui"],
    ["/api/auth/session", "ui"],
    ["/api/trpc/location.makeTree", "ui"],
    ["/api/mcp", "mcp"],
    ["/api/debug/timing", "other"],
  ] as const)("classifies HTTP path %s as %s", (path, workload) => {
    expect(classifyHttpWorkload(path)).toBe(workload);
  });

  it("classifies async-generator tRPC results as import streams", () => {
    async function* stream() {
      yield { done: 1, total: 2 };
    }

    expect(classifyTrpcWorkload("ui", stream())).toBe("import-stream");
  });

  it.each([
    ["ui", "ui"],
    ["mcp", "mcp"],
    ["agent", "other"],
    ["api", "other"],
  ] as const)("classifies %s tRPC calls as %s", (origin, workload) => {
    expect(classifyTrpcWorkload(origin)).toBe(workload);
  });
});
