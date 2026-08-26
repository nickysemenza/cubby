import { describe, expect, it } from "vitest";
import { visibleTodayTasks } from "./HouseCard";

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
});
