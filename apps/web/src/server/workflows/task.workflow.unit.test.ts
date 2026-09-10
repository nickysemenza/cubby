import { describe, expect, it } from "vitest";

import {
  taskBulkReorderWorkflow,
  taskBoardWorkflow,
  taskChartDataWorkflow,
  taskListActionableWorkflow,
  taskTimelineWorkflow,
  taskTodayBriefingWorkflow,
} from "./task.server";

describe("task workflow definitions", () => {
  it("runs reorder effects only after the domain mutation", () => {
    expect(
      taskBulkReorderWorkflow.definition.steps.map((step) => step.type),
    ).toEqual(["committedCall", "committedEffect", "committedEffect"]);
  });
  it("registers the direct task delegates with stable operation ids", () => {
    expect(taskListActionableWorkflow.definition.name).toBe(
      "task.listActionable",
    );
    expect(taskTodayBriefingWorkflow.definition.name).toBe(
      "task.todayBriefing",
    );
    expect(taskBoardWorkflow.definition.name).toBe("task.board");
    expect(taskChartDataWorkflow.definition.name).toBe("task.chartData");
    expect(taskTimelineWorkflow.definition.name).toBe("task.timeline");
    for (const workflow of [
      taskListActionableWorkflow,
      taskTodayBriefingWorkflow,
      taskChartDataWorkflow,
      taskBoardWorkflow,
      taskTimelineWorkflow,
    ]) {
      expect(workflow.definition.steps).toHaveLength(1);
      expect(workflow.definition.steps[0]?.type).toBe("call");
    }
  });
});
