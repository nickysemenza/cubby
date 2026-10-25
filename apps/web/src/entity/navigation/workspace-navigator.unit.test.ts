import { describe, expect, it } from "vitest";

import { filterWorkspaceDestinations } from "./workspace-navigator";

describe("workspace navigator", () => {
  it("searches the complete destination universe by label and context", () => {
    expect(
      filterWorkspaceDestinations("debug").map(({ item }) => item.to),
    ).toContain("/search/debug");
    expect(
      filterWorkspaceDestinations("dev").map(({ item }) => item.to),
    ).toContain("/mcp");
  });

  it("uses the existing quick-action keywords", () => {
    expect(
      filterWorkspaceDestinations("groceries").map(({ item }) => item.to),
    ).toContain("/meals/shopping-list");
  });
});
