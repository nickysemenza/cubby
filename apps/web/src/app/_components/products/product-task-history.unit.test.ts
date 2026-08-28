import type { TaskOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { orderProductTasks } from "./product-task-history";

// Shortcode body alphabet excludes 0, 1, I, O, L to avoid visual ambiguity.
const SHORTCODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
let taskShortcodeCounter = 0;
const nextTaskShortcode = () =>
  testShortcode(
    "task",
    `TSK-234${SHORTCODE_ALPHABET[taskShortcodeCounter++ % SHORTCODE_ALPHABET.length]}`,
  );

const task = (
  name: string,
  options: {
    status?: TaskOut["status"];
    dueDate?: string | null;
    dueEndDate?: string | null;
    createdAt?: string;
  } = {},
): TaskOut => ({
  // The task's public id IS its shortcode now (see the project/task/expense
  // shortcode cutover) — there is no separate internal id on this Out type.
  id: nextTaskShortcode(),
  name,
  status: options.status ?? "not_started",
  projectId: null,
  projectName: null,
  subjectProductId: null,
  subjectProductName: null,
  parentTaskId: null,
  parentTaskName: null,
  dueDate: options.dueDate ?? null,
  dueEndDate: options.dueEndDate ?? null,
  trade: "other",
  sortOrder: null,
  blockedByIds: [],
  blockingIds: [],
  subtaskCount: 0,
  doneSubtaskCount: 0,
  createdAt: new Date(options.createdAt ?? "2026-01-01"),
  updatedAt: new Date(options.createdAt ?? "2026-01-01"),
});

describe("orderProductTasks", () => {
  it("puts open work first by effective due date, then completed history newest first", () => {
    const rows = [
      task("done old", { status: "done", dueDate: "2025-01-01" }),
      task("open later", { dueDate: "2026-08-01" }),
      task("done recent", { status: "done", dueEndDate: "2026-07-01" }),
      task("open range ending soon", {
        dueDate: "2026-07-01",
        dueEndDate: "2026-07-30",
      }),
      task("open undated", { createdAt: "2026-07-29" }),
    ];

    expect(orderProductTasks(rows).map((row) => row.name)).toEqual([
      "open range ending soon",
      "open later",
      "open undated",
      "done recent",
      "done old",
    ]);
  });

  it("uses newest creation time as the stable fallback for undated rows", () => {
    const rows = [
      task("older open", { createdAt: "2026-01-01" }),
      task("newer open", { createdAt: "2026-02-01" }),
      task("older done", { status: "done", createdAt: "2025-01-01" }),
      task("newer done", { status: "done", createdAt: "2025-02-01" }),
    ];

    expect(orderProductTasks(rows).map((row) => row.name)).toEqual([
      "newer open",
      "older open",
      "newer done",
      "older done",
    ]);
  });
});
