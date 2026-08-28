import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { householdDaysAgo } from "~/lib/household-date";

import { createExpense } from "./expense";
import { computeAttentionItems, createProject, projectList } from "./project";
import { createTask, taskList } from "./task";

describe("tracker entity-list filters", () => {
  const ctx = withTestDb();

  it("matches overdue Problems to the top-level open-task list", async () => {
    const { output: overdue } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker filter overdue",
        dueDate: householdDaysAgo(2),
      }),
      ctx.actor,
    );
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "tracker filter parent" }),
      ctx.actor,
    );
    const { output: subtask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker filter subtask",
        parentTaskId: parent.id,
        dueDate: householdDaysAgo(2),
      }),
      ctx.actor,
    );

    const [attention, list] = await Promise.all([
      computeAttentionItems(ctx.db),
      taskList(
        ctx.db,
        {
          dueRelative: "beforeToday",
          completion: "open",
          parentTaskPresenceFilter: "none",
        },
        [{ orderBy: "dueDate", direction: "asc" }],
        { pageIndex: 0, pageSize: 100 },
      ),
    ]);

    const detectorIds = attention
      .filter((item) => item.type === "overdue_task")
      .map((item) => item.entityId);
    expect(new Set(list.data.map((row) => row.id))).toEqual(
      new Set(detectorIds),
    );
    expect(detectorIds).toContain(overdue.id);
    expect(detectorIds).not.toContain(subtask.id);
  });

  it("delegates missing-budget list membership to the canonical attention rule", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "tracker filter unbudgeted" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "tracker filter spend",
        trade: "other",
        costType: "materials",
        projectId: project.id,
        cost: 25,
        date: householdDaysAgo(1),
      }),
      ctx.actor,
    );

    const [attention, list] = await Promise.all([
      computeAttentionItems(ctx.db),
      projectList(ctx.db, { attention: "missing_budget" }, [], {
        pageIndex: 0,
        pageSize: 100,
      }),
    ]);
    const detectorIds = attention
      .filter((item) => item.type === "missing_budget")
      .map((item) => item.entityId);
    expect(new Set(list.data.map((row) => row.id))).toEqual(
      new Set(detectorIds),
    );
    expect(detectorIds).toContain(project.id);
  });
});
