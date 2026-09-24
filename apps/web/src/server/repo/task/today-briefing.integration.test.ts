import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createProject } from "~/server/repo/project";
import { createTask } from "~/server/repo/task";

import { getTaskTodayBriefing } from "./today-briefing";

describe("task today briefing", () => {
  const ctx = withTestDb();

  it("carries the joined project icon so the home row needs no project roster lookup", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Workshop", icon: "🔧" }),
      ctx.actor,
    );
    const task = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Check the workbench",
        trade: "other",
        projectId: project.output.id,
      }),
      ctx.actor,
    );

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
