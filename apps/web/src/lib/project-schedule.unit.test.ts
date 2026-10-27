import type { ProjectOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { buildDetailScheduleRows } from "./project-schedule";

type ScheduleTask = Parameters<typeof buildDetailScheduleRows>[2][number];

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
    dates: start || end ? { start: start ?? null, end: end ?? null } : null,
    fields: {
      dateWindow: {
        result: {
          kind: "live",
          decision: {
            provenance: { kind: "computed" },
            outcome: {
              kind: "value",
              value: {
                effectiveStart: start ?? null,
                effectiveEnd: end ?? null,
                startSource: start ? "explicit" : "none",
                endSource: end ? "explicit" : "none",
              },
            },
          },
        },
        work: { kind: "idle" },
      },
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
): ScheduleTask {
  return fromPartial<ScheduleTask>({
    id: taskId(seed),
    name: seed,
    projectId: owner ? projectId(owner) : null,
    parentTaskId: parent ? taskId(parent) : null,
    status: "not_started",
    due: due || dueEnd ? { start: due ?? null, end: dueEnd ?? null } : null,
    blockedByIds: [],
    blockingIds: [],
  });
}

describe("detail schedule rows", () => {
  it("distinguishes missing and failed windows from a completed empty window", () => {
    const root = project("pending");
    root.fields.dateWindow = fromPartial<ProjectOut["fields"]["dateWindow"]>({
      result: { kind: "missing" },
      work: { kind: "pending" },
    });
    expect(buildDetailScheduleRows(root, [], [])[0]?.noDateLabel).toBe(
      "Updating…",
    );
    root.fields.dateWindow.work = {
      kind: "failed",
      error: "Synthetic window failure",
      retryAt: null,
    };
    const failed = buildDetailScheduleRows(root, [], [])[0];
    expect(failed?.noDateLabel).toBe("Unavailable");
    expect(failed?.meta).toContain("Synthetic window failure");
    expect(
      buildDetailScheduleRows(project("empty"), [], [])[0]?.noDateLabel,
    ).toBe("No dates");
  });

  it("includes every nested task, including undated inherited subtasks", () => {
    const root = project("root");
    const phase = project("phase", "root", "2026-07-02", "2026-07-08");
    const work = task("work", "phase", undefined, "2026-07-04");
    const subtask = task("subtask", null, "work");
    const rows = buildDetailScheduleRows(root, [phase], [work, subtask]);
    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ["root", 0],
      ["phase", 1],
      ["work", 2],
      ["subtask", 3],
    ]);
    expect(rows.at(-1)?.noDateLabel).toBe("No due date");
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
    const row = buildDetailScheduleRows(root, [], [endOnly])[1];
    expect(row?.noDateLabel).toBeUndefined();
    expect(row?.segments).toEqual([
      {
        id: `${endOnly.id}:due`,
        label: "end-only due end",
        startDate: "2026-09-12",
        variant: "milestone",
      },
    ]);
    expect(row?.meta).toContain("Due end only");
  });
});
