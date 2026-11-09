import { describe, expect, it } from "vitest";

import { getStatusBadgeProps } from "./status-colors";
import { statusTone } from "./status-tone";

describe("statusTone", () => {
  it("tones a status by condition and falls back to a neutral chip", () => {
    expect(statusTone("task", "done")).toBe("positive");
    expect(statusTone("task", "blocked")).toBe("destructive");
    expect(statusTone("audit", "delete")).toBe("destructive");
    expect(statusTone("task", "not-a-status")).toBe("slate");
    expect(statusTone("task", null)).toBe("slate");
  });

  it("gives the project badge domain a tone for task-only statuses too", () => {
    expect(getStatusBadgeProps("project", "blocked")).toMatchObject({
      label: "Blocked",
      variant: "destructive",
    });
    expect(getStatusBadgeProps("project", "planning").variant).toBe("plum");
  });
});
