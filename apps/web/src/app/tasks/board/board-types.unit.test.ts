import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { asCardDropData, asDragData, asDropData } from "./board-types";

describe("task board drag data parsing", () => {
  it("parses branded shortcode fields at the dnd-kit ingress", () => {
    const taskId = testShortcode("task", "dragged");
    const projectId = testShortcode("project", "target");

    expect(
      asDragData({
        taskBoardDrag: true,
        taskId,
        status: "in_progress",
        projectId,
        trade: "building",
      }),
    ).toEqual({
      taskBoardDrag: true,
      taskId,
      status: "in_progress",
      projectId,
      trade: "building",
    });
    expect(
      asDropData({
        taskBoardTarget: true,
        column: { kind: "project", projectId, projectName: "Kitchen" },
        lane: null,
      }),
    ).not.toBeNull();
    expect(
      asCardDropData({
        taskBoardCardTarget: true,
        column: { kind: "status", status: "done" },
        lane: { kind: "trade", trade: "building" },
        targetTaskId: taskId,
      }),
    ).not.toBeNull();
  });

  it("rejects malformed or cross-entity identifiers", () => {
    expect(
      asDragData({
        taskBoardDrag: true,
        taskId: testShortcode("product", "wrong-entity"),
        status: "in_progress",
        projectId: null,
        trade: "building",
      }),
    ).toBeNull();
    expect(
      asDropData({
        taskBoardTarget: true,
        column: { kind: "status", status: "unknown" },
        lane: null,
      }),
    ).toBeNull();
  });
});
