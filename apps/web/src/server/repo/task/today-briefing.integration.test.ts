import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getTaskTodayBriefing } from "./today-briefing";

describe("task today briefing", () => {
  const ctx = withTestDb();

  it("carries the joined project icon so the home row needs no project roster lookup", async () => {
    const project = await createRepoEntity(ctx, "project", {
      name: "Workshop",
      icon: "🔧",
    });
    const task = await createRepoEntity(ctx, "task", {
      name: "Check the workbench",
      trade: "other",
      projectId: project.output.id,
    });

    const briefing = await getTaskTodayBriefing(ctx.db);
    expect(briefing.next).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: task.output.id,
          projectId: project.output.id,
          projectName: "Workshop",
          projectIcon: "🔧",
        }),
      ]),
    );
  });
});
