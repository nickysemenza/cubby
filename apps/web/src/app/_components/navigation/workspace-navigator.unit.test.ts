import { describe, expect, it } from "vitest";

import {
  filterWorkspaceDestinations,
  workspaceNavigatorLeavesForTest,
} from "./workspace-navigator";

describe("workspace navigator", () => {
  it("searches the complete destination universe by label and context", () => {
    expect(
      filterWorkspaceDestinations("background").map(({ item }) => item.to),
    ).toContain("/background-jobs");
    expect(
      filterWorkspaceDestinations("dev").map(({ item }) => item.to),
    ).toContain("/mcp");
  });

  it("uses the existing quick-action keywords", () => {
    expect(
      filterWorkspaceDestinations("groceries").map(({ item }) => item.to),
    ).toContain("/meals/shopping-list");
  });

  it("contains every canonical leaf exactly once", () => {
    const routes = workspaceNavigatorLeavesForTest.map((item) => item.to);
    expect(new Set(routes).size).toBe(routes.length);
  });
});
