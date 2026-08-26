import { describe, expect, it } from "vitest";
import { TODAY_ENTITY_LINK_CLASS, visibleTodayTasks } from "./HouseCard";

describe("visibleTodayTasks", () => {
  it("keeps the server-authored priority order and only bounds its display", () => {
    const rows = ["overdue", "due-now", "in-progress", "undated", "later"];

    expect(visibleTodayTasks(rows)).toEqual([
      "overdue",
      "due-now",
      "in-progress",
      "undated",
    ]);
  });

  it("gives task and project anchors a phone-sized target", () => {
    expect(TODAY_ENTITY_LINK_CLASS).toContain("min-h-11");
    expect(TODAY_ENTITY_LINK_CLASS).toContain("sm:min-h-0");
  });
});
