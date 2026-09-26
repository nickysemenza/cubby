import { taskTodayBriefingOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { task } from "~/app/tasks/task.functions";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { TodayAttention } from "./HouseCard";

describe("home task project identity", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  let restoreDispatch: (() => void) | undefined;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    restoreDispatch?.();
    harness.dispose();
  });

  it("uses the briefing icon without requesting the project roster", async () => {
    const taskId = testShortcode("task", "home-briefing-task");
    const projectId = testShortcode("project", "home-briefing-project");
    harness.queryClient.setQueryData(
      task.todayBriefing.queryOptions().queryKey,
      taskTodayBriefingOut.parse({
        next: [
          {
            id: taskId,
            name: "Check the workbench",
            status: "not_started",
            dueDate: null,
            dueEndDate: null,
            projectId,
            projectName: "Workshop",
            projectIcon: "🔧",
          },
        ],
        nextCount: 1,
        laterCount: 0,
        blockedCount: 0,
        overdueCount: 0,
        dueThisWeekCount: 0,
      }),
    );
    const requests: string[] = [];
    restoreDispatch = overrideStartDispatch(async (operation) => {
      requests.push(operation);
      if (operation === "entityMedia.displayImages")
        return { ok: true, data: {} };
      throw new Error(`Unexpected home request: ${operation}`);
    });

    render(<TodayAttention />, { wrapper: harness.wrapper });

    expect(await screen.findByText("🔧")).toBeVisible();
    await waitFor(() =>
      expect(requests).toContain("entityMedia.displayImages"),
    );
    expect(requests).not.toContain("entity.filterOptions");
  });
});
