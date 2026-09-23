import type {
  ProjectListItemOut,
  ProjectOut,
  TaskOut,
} from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import {
  buildDetailScheduleRows,
  buildPortfolioScheduleRows,
  projectScheduleWindow,
} from "./project-schedule-model";

const projectId = (seed: string) => testShortcode("project", seed);
const taskId = (seed: string) => testShortcode("task", seed);

function project(
  seed: string,
  parent?: string,
  start?: string,
  end?: string,
): ProjectOut {
  return fromPartial<ProjectOut>({
    id: projectId(seed),
    name: seed,
    status: "planning",
    parentProjectId: parent ? projectId(parent) : null,
    dates: {
      effectiveStart: start ?? null,
      effectiveEnd: end ?? null,
      startSource: start ? "explicit" : "none",
      endSource: end ? "explicit" : "none",
    },
    blockedByIds: [],
    blockingIds: [],
  });
}

function task(
  seed: string,
  owner: string | null,
  parent?: string,
  due?: string,
  dueEnd?: string,
): TaskOut {
  return fromPartial<TaskOut>({
    id: taskId(seed),
    name: seed,
    projectId: owner ? projectId(owner) : null,
    parentTaskId: parent ? taskId(parent) : null,
    status: "not_started",
    dueDate: due ?? null,
    dueEndDate: dueEnd ?? null,
    blockedByIds: [],
    blockingIds: [],
  });
}

describe("project schedule rows", () => {
  it("keeps an undated child under its paginated project root", () => {
    const parent = project("root", undefined, "2026-05-01", "2026-05-10");
    const child = project("child", "root");
    const rows = buildPortfolioScheduleRows(
      [
        fromPartial<ProjectListItemOut>(parent),
        fromPartial<ProjectListItemOut>(child),
      ],
      new Set(),
    );
    expect(rows.map((row) => [row.name, row.depth, row.noDateLabel])).toEqual([
      ["root", 0, undefined],
      ["child", 1, "No dates"],
    ]);
    expect(
      buildPortfolioScheduleRows(
        [
          fromPartial<ProjectListItemOut>(parent),
          fromPartial<ProjectListItemOut>(child),
        ],
        new Set([parent.id]),
      ).map((row) => row.id),
    ).toEqual([parent.id]);
  });

  it("includes every nested task, including undated inherited subtasks", () => {
    const root = project("root");
    const phase = project("phase", "root", "2026-07-02", "2026-07-08");
    const work = task("work", "phase", undefined, "2026-07-04");
    const subtask = task("subtask", null, "work");
    const rows = buildDetailScheduleRows(
      root,
      [phase],
      [work, subtask],
      new Set(),
    );
    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ["root", 0],
      ["phase", 1],
      ["work", 2],
      ["subtask", 3],
    ]);
    expect(rows.at(-1)?.noDateLabel).toBe("No due date");
    expect(
      projectScheduleWindow(rows, new Date("2026-01-01T00:00:00Z")),
    ).toEqual({
      startDate: "2026-06-18",
      endDate: "2026-08-22",
    });
    expect(
      buildDetailScheduleRows(
        root,
        [phase],
        [work, subtask],
        new Set([phase.id]),
      ).map((row) => row.name),
    ).toEqual(["root", "phase"]);
  });

  it("keeps an end-only task on the timeline as a due-end milestone", () => {
    const root = project("root");
    const endOnly = task(
      "end-only",
      "root",
      undefined,
      undefined,
      "2026-09-12",
    );
    const row = buildDetailScheduleRows(root, [], [endOnly], new Set())[1];
    expect(row?.noDateLabel).toBeUndefined();
    expect(row?.segments).toEqual([
      {
        id: `${endOnly.id}:due`,
        label: "end-only due end",
        startDate: "2026-09-12",
        variant: "milestone",
        color: "var(--domain-plan)",
      },
    ]);
    expect(row?.meta).toContain("Due end only");
  });
});
