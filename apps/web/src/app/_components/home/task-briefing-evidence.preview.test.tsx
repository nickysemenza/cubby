import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { TaskBriefingEvidenceLine } from "./HouseCard";

it("keeps each task summary item on one line in a narrow briefing", async () => {
  await page.viewport(402, 874);
  const { container } = render(
    <div style={{ width: 120 }}>
      <TaskBriefingEvidenceLine
        briefing={{
          next: [],
          nextCount: 0,
          laterCount: 0,
          blockedCount: 1,
          overdueCount: 2,
          dueThisWeekCount: 3,
        }}
      />
    </div>,
  );

  const overdue = screen.getByText("2 overdue").getBoundingClientRect();
  const due = screen.getByText("3 due this week").getBoundingClientRect();
  const brief = container.firstElementChild!.getBoundingClientRect();

  expect(due.top).toBeGreaterThanOrEqual(overdue.bottom - 1);
  expect(due.height).toBeCloseTo(overdue.height, 0);
  expect(due.right).toBeLessThanOrEqual(brief.right + 1);
});
