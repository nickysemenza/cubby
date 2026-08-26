import { describe, expect, it } from "vitest";
import {
  TODAY_ENTITY_LINK_CLASS,
  taskBriefingEvidence,
  taskBriefingSecondary,
} from "./HouseCard";

describe("TodayAttention", () => {
  it("uses the server's full counts without reconstructing the task queue client-side", () => {
    const briefing = {
      next: [
        {
          id: "tsk_a",
          name: "First ready task",
          status: "not_started" as const,
          dueDate: null,
          dueEndDate: null,
          projectId: null,
          projectName: null,
        },
      ],
      nextCount: 5,
      laterCount: 2,
      blockedCount: 3,
      overdueCount: 1,
      dueThisWeekCount: 4,
    };

    expect(taskBriefingSecondary(briefing)).toBe(
      "4 more ready · 2 later · 3 blocked",
    );
    expect(taskBriefingEvidence(briefing)).toBe(
      "1 overdue · 4 due this week · 3 blocked",
    );
  });

  it("gives task and project anchors a phone-sized target", () => {
    expect(TODAY_ENTITY_LINK_CLASS).toContain("min-h-11");
    expect(TODAY_ENTITY_LINK_CLASS).toContain("sm:min-h-0");
  });
});
