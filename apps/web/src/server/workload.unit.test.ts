import { describe, expect, it } from "vitest";

import { classifyHttpWorkload } from "./workload";

describe("performance workload classification", () => {
  it.each([
    ["/api/auth/session", "other"],
    ["/_serverFn/getGuardSession", "ui"],
    ["/api/mcp", "mcp"],
    ["/api/debug/timing", "other"],
  ] as const)("classifies HTTP path %s as %s", (path, workload) => {
    expect(classifyHttpWorkload(path)).toBe(workload);
  });

  it("separates browser documents from static assets", () => {
    expect(
      classifyHttpWorkload("/locations", new Headers({ accept: "text/html" })),
    ).toBe("ui");
    expect(
      classifyHttpWorkload(
        "/assets/app.js",
        new Headers({ accept: "application/javascript" }),
      ),
    ).toBe("other");
  });
});
