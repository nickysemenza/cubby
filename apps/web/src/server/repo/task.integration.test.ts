import {
  unsafeProductId,
  unsafeProductShortcode,
  unsafeProjectShortcode,
  unsafeTaskShortcode,
} from "@cubby/schemas/identifiers";
import {
  actionableTasksOut,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { householdDaysAgo, householdDaysFromNow } from "~/lib/household-date";
import { taskRouter } from "~/server/api/routers/task";
import { createTestCaller } from "~/server/api/trpc";
import { getAuditLog } from "~/server/repo/audit-log";
import { createProduct, deleteProducts } from "~/server/repo/product";
import {
  createProject,
  deleteProjects,
  updateProject,
} from "~/server/repo/project";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  createTask,
  deleteTasks,
  getTaskBoard,
  getTaskByShortcode,
  getTaskSummary,
  moveTasks,
  setTasksStatus,
  taskList,
  updateTask,
} from "~/server/repo/task";
import { listActionableTasks } from "~/server/repo/task/actionable";
import { makeProductInput } from "./repo.fixtures";

describe("task repository — listActionableTasks", () => {
  const ctx = withTestDb();

  it("an unblocked task is actionable", async () => {
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "solo task" }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);

    expect(result.next.map((r) => r.id)).toContain(t.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(t.id);
  });

  it("a task blocked by an open task edge is blocked, and frees once the blocker is marked done", async () => {
    const { output: blocker } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "blocker task" }),
      ctx.actor,
    );
    const { output: blocked } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "blocked task" }),
      ctx.actor,
    );
    await updateTask(
      ctx.db,
      blocked.id,
      { blockedByIds: [blocker.id] },
      ctx.actor,
    );

    const beforeDone = await listActionableTasks(ctx.db);
    const row = beforeDone.blocked.find((r) => r.task.id === blocked.id);
    expect(row).toBeDefined();
    expect(row?.reasons).toEqual([
      {
        kind: "task",
        chain: [
          {
            id: blocker.id,
            name: blocker.name,
            status: blocker.status,
            type: "task",
          },
        ],
      },
    ]);
    expect(beforeDone.next.map((r) => r.id)).not.toContain(blocked.id);

    await updateTask(ctx.db, blocker.id, { status: "done" }, ctx.actor);

    const afterDone = await listActionableTasks(ctx.db);
    expect(afterDone.next.map((r) => r.id)).toContain(blocked.id);
    expect(afterDone.blocked.map((r) => r.task.id)).not.toContain(blocked.id);
  });

  it("a project-edge blockage is inherited by the project's tasks", async () => {
    const { output: blockerProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "blocker project" }),
      ctx.actor,
    );
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "blocked project" }),
      ctx.actor,
    );
    await updateProject(
      ctx.db,
      project.id,
      { blockedByIds: [blockerProject.id] },
      ctx.actor,
    );
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "task in a blocked project",
        projectId: project.id,
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);
    const row = result.blocked.find((r) => r.task.id === t.id);

    expect(row).toBeDefined();
    expect(row?.reasons).toEqual([
      {
        kind: "project",
        chain: [
          {
            id: blockerProject.id,
            name: blockerProject.name,
            status: blockerProject.status,
            type: "project",
          },
        ],
      },
    ]);
  });

  it("excludes a manually-blocked task from actionable, with a manual reason", async () => {
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "manually blocked",
        status: "blocked",
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);
    const row = result.blocked.find((r) => r.task.id === t.id);

    expect(row?.reasons).toEqual([{ kind: "manual", chain: [] }]);
    expect(result.next.map((r) => r.id)).not.toContain(t.id);
    expect(result.later.map((r) => r.id)).not.toContain(t.id);
  });

  it("a later task with no blockers appears in `later`, not `next`", async () => {
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "later task",
        status: "later",
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);

    expect(result.later.map((r) => r.id)).toContain(t.id);
    expect(result.next.map((r) => r.id)).not.toContain(t.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(t.id);
  });

  it("builds the transitive chain (A blocked by B, B blocked by C -> A's chain = [B, C])", async () => {
    const { output: c } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "task c" }),
      ctx.actor,
    );
    const { output: b } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "task b" }),
      ctx.actor,
    );
    const { output: a } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "task a" }),
      ctx.actor,
    );
    await updateTask(ctx.db, b.id, { blockedByIds: [c.id] }, ctx.actor);
    await updateTask(ctx.db, a.id, { blockedByIds: [b.id] }, ctx.actor);

    const result = await listActionableTasks(ctx.db);
    const row = result.blocked.find((r) => r.task.id === a.id);

    expect(row?.reasons).toHaveLength(1);
    expect(row?.reasons[0]?.chain.map((n) => n.id)).toEqual([b.id, c.id]);
  });

  it("a soft-deleted blocker task does not block", async () => {
    const { output: blocker } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "soon-deleted blocker" }),
      ctx.actor,
    );
    const { output: blocked } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "waiting on a deleted blocker",
      }),
      ctx.actor,
    );
    await updateTask(
      ctx.db,
      blocked.id,
      { blockedByIds: [blocker.id] },
      ctx.actor,
    );
    await deleteTasks(ctx.db, [blocker.id], ctx.actor);

    const result = await listActionableTasks(ctx.db);

    expect(result.next.map((r) => r.id)).toContain(blocked.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(blocked.id);
  });

  it("a done blocker does not block", async () => {
    const { output: blocker } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "done blocker" }),
      ctx.actor,
    );
    const { output: blocked } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "waiting on a done blocker",
      }),
      ctx.actor,
    );
    await updateTask(
      ctx.db,
      blocked.id,
      { blockedByIds: [blocker.id] },
      ctx.actor,
    );
    await updateTask(ctx.db, blocker.id, { status: "done" }, ctx.actor);

    const result = await listActionableTasks(ctx.db);

    expect(result.next.map((r) => r.id)).toContain(blocked.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(blocked.id);
  });

  it("a task in a grandchild project is blocked when the ROOT ancestor has an open blocked-by edge", async () => {
    const { output: blockerProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "root blocker project" }),
      ctx.actor,
    );
    const { output: root } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "root project" }),
      ctx.actor,
    );
    await updateProject(
      ctx.db,
      root.id,
      { blockedByIds: [blockerProject.id] },
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "child project",
        parentProjectId: root.id,
      }),
      ctx.actor,
    );
    const { output: grandchild } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "grandchild project",
        parentProjectId: child.id,
      }),
      ctx.actor,
    );
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "task in a grandchild project",
        projectId: grandchild.id,
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);
    const row = result.blocked.find((r) => r.task.id === t.id);

    expect(row).toBeDefined();
    expect(row?.reasons).toEqual([
      {
        kind: "project",
        chain: [
          {
            id: blockerProject.id,
            name: blockerProject.name,
            status: blockerProject.status,
            type: "project",
          },
        ],
      },
    ]);
    expect(result.next.map((r) => r.id)).not.toContain(t.id);

    // Unblocked once the root ancestor's blocker is marked done.
    await updateProject(
      ctx.db,
      blockerProject.id,
      { status: "done" },
      ctx.actor,
    );
    const afterDone = await listActionableTasks(ctx.db);
    expect(afterDone.next.map((r) => r.id)).toContain(t.id);
    expect(afterDone.blocked.map((r) => r.task.id)).not.toContain(t.id);
  });

  it("a done intermediate ancestor's own blocked-by edges don't block", async () => {
    const { output: blockerProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "intermediate blocker project" }),
      ctx.actor,
    );
    const { output: root } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "root project two" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "done intermediate child",
        parentProjectId: root.id,
      }),
      ctx.actor,
    );
    // The intermediate ancestor (child) has its own open blocked-by edge, but
    // is itself `done` — its edges must not propagate to the grandchild.
    await updateProject(
      ctx.db,
      child.id,
      { status: "done", blockedByIds: [blockerProject.id] },
      ctx.actor,
    );
    const { output: grandchild } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "grandchild under done intermediate",
        parentProjectId: child.id,
      }),
      ctx.actor,
    );
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "task under a done intermediate ancestor",
        projectId: grandchild.id,
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);

    expect(result.next.map((r) => r.id)).toContain(t.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(t.id);
  });

  it("orders `next`: overdue first, then effective due date ascending, then in_progress before not_started, then name", async () => {
    const yesterday = householdDaysAgo(1);
    const tomorrow = householdDaysFromNow(1);

    const { output: noDueZ } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "Z no due date" }),
      ctx.actor,
    );
    const { output: noDueA } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "A no due date" }),
      ctx.actor,
    );
    const { output: dueTomorrowInProgress } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "due tomorrow, in progress",
        dueDate: tomorrow,
        status: "in_progress",
      }),
      ctx.actor,
    );
    const { output: dueTomorrowNotStarted } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "due tomorrow, not started",
        dueDate: tomorrow,
      }),
      ctx.actor,
    );
    const { output: overdue } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "overdue task",
        dueDate: yesterday,
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);
    const relevantIds = new Set([
      noDueZ.id,
      noDueA.id,
      dueTomorrowInProgress.id,
      dueTomorrowNotStarted.id,
      overdue.id,
    ]);
    const ordered = result.next
      .filter((r) => relevantIds.has(r.id))
      .map((r) => r.id);

    expect(ordered).toEqual([
      overdue.id,
      dueTomorrowInProgress.id,
      dueTomorrowNotStarted.id,
      noDueA.id,
      noDueZ.id,
    ]);
  });

  it("orders `later`: due date ascending (nulls last), then updatedAt descending", async () => {
    const soon = householdDaysFromNow(1);
    const later = householdDaysFromNow(2);

    const { output: dueLater } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "later, due further out",
        dueDate: later,
        status: "later",
      }),
      ctx.actor,
    );
    const { output: dueSoon } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "later, due sooner",
        dueDate: soon,
        status: "later",
      }),
      ctx.actor,
    );
    const { output: noDueOlderUpdate } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "no due, updated later",
        status: "later",
      }),
      ctx.actor,
    );
    const { output: noDueNewerCreate } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "no due, created later",
        status: "later",
      }),
      ctx.actor,
    );
    // Touch noDueOlderUpdate's row after noDueNewerCreate was inserted, so its
    // updatedAt is now the more recent of the two no-due rows.
    await updateTask(
      ctx.db,
      noDueOlderUpdate.id,
      { trade: "other" },
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);
    const relevantIds = new Set([
      dueLater.id,
      dueSoon.id,
      noDueOlderUpdate.id,
      noDueNewerCreate.id,
    ]);
    const ordered = result.later
      .filter((r) => relevantIds.has(r.id))
      .map((r) => r.id);

    expect(ordered).toEqual([
      dueSoon.id,
      dueLater.id,
      noDueOlderUpdate.id,
      noDueNewerCreate.id,
    ]);
  });

  it("orders `blocked`: effective due date ascending (nulls last), then name ascending", async () => {
    const soon = householdDaysFromNow(1);
    const later = householdDaysFromNow(2);

    const { output: blockedNoDueZ } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "Z blocked, no due",
        status: "blocked",
      }),
      ctx.actor,
    );
    const { output: blockedNoDueA } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "A blocked, no due",
        status: "blocked",
      }),
      ctx.actor,
    );
    const { output: blockedDueLater } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "blocked, due further out",
        status: "blocked",
        dueDate: later,
      }),
      ctx.actor,
    );
    const { output: blockedDueSoon } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "blocked, due sooner",
        status: "blocked",
        dueDate: soon,
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);
    const relevantIds = new Set([
      blockedNoDueZ.id,
      blockedNoDueA.id,
      blockedDueLater.id,
      blockedDueSoon.id,
    ]);
    const ordered = result.blocked
      .filter((r) => relevantIds.has(r.task.id))
      .map((r) => r.task.id);

    expect(ordered).toEqual([
      blockedDueSoon.id,
      blockedDueLater.id,
      blockedNoDueA.id,
      blockedNoDueZ.id,
    ]);
  });
});

describe("task router — listActionable", () => {
  const ctx = withTestDb();
  // Built fresh per test — see suggestions.integration.test.ts's comment on
  // why callers read the current `db` closure via beforeEach.
  let taskCaller: ReturnType<
    typeof createTestCaller<(typeof taskRouter)["_def"]["record"]>
  >;

  beforeEach(() => {
    taskCaller = createTestCaller(taskRouter, ctx.db);
  });

  it("listActionable output satisfies the published schema", async () => {
    await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "router test task" }),
      ctx.actor,
    );

    const result = await taskCaller.listActionable();

    // The .output() contract must accept real repo output (pins schema<->repo).
    expect(() => actionableTasksOut.parse(result)).not.toThrow();
  });
});

// One level of checklist subtasks (task.parentTaskId). Parent status stays
// fully manual — none of these assert any auto-completion of the parent.
describe("task repository — subtasks (parentTaskId)", () => {
  const ctx = withTestDb();

  it("create with parentTaskId inherits the parent's projectId when omitted", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "subtask project" }),
      ctx.actor,
    );
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "parent task",
        projectId: project.id,
      }),
      ctx.actor,
    );

    const { output: subtask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "subtask",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );

    expect(subtask.parentTaskId).toBe(parent.id);
    expect(subtask.projectId).toBe(project.id);
  });

  it("create with parentTaskId and an explicit projectId keeps the explicit projectId", async () => {
    const { output: parentProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "parent project" }),
      ctx.actor,
    );
    const { output: otherProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "other project" }),
      ctx.actor,
    );
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "parent task",
        projectId: parentProject.id,
      }),
      ctx.actor,
    );

    const { output: subtask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "subtask with explicit project",
        parentTaskId: parent.id,
        projectId: otherProject.id,
      }),
      ctx.actor,
    );

    expect(subtask.projectId).toBe(otherProject.id);
  });

  it("rejects a parent that is itself a subtask — only one level of nesting", async () => {
    const { output: grandparent } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "grandparent" }),
      ctx.actor,
    );
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "parent",
        parentTaskId: grandparent.id,
      }),
      ctx.actor,
    );

    await expect(
      createTask(
        ctx.db,
        taskCreateInput.parse({
          trade: "other",
          name: "grandchild",
          parentTaskId: parent.id,
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(/only one level/i);
  });

  it("rejects giving a parent to a task that already has live subtasks", async () => {
    const { output: futureSubtask } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "future subtask target" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "existing subtask",
        parentTaskId: futureSubtask.id,
      }),
      ctx.actor,
    );
    const { output: otherTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "other task" }),
      ctx.actor,
    );

    await expect(
      updateTask(
        ctx.db,
        futureSubtask.id,
        { parentTaskId: otherTask.id },
        ctx.actor,
      ),
    ).rejects.toThrow(/cannot itself become a subtask/i);
  });

  it("rejects a task being its own parent", async () => {
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "self parent" }),
      ctx.actor,
    );

    await expect(
      updateTask(ctx.db, t.id, { parentTaskId: t.id }, ctx.actor),
    ).rejects.toThrow(/cannot be its own parent/i);
  });

  it("rejects a nonexistent parent (create and update)", async () => {
    const bogus = unsafeTaskShortcode("TSK-ZZZZ");

    await expect(
      createTask(
        ctx.db,
        taskCreateInput.parse({
          trade: "other",
          name: "orphan",
          parentTaskId: bogus,
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(/not found/i);

    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "will get a bogus parent",
      }),
      ctx.actor,
    );
    await expect(
      updateTask(ctx.db, t.id, { parentTaskId: bogus }, ctx.actor),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a soft-deleted parent", async () => {
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "soon-deleted parent" }),
      ctx.actor,
    );
    await deleteTasks(ctx.db, [parent.id], ctx.actor);

    await expect(
      createTask(
        ctx.db,
        taskCreateInput.parse({
          trade: "other",
          name: "orphaned by deletion",
          parentTaskId: parent.id,
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("update can clear parentTaskId", async () => {
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "parent" }),
      ctx.actor,
    );
    const { output: subtask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "subtask",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );

    const { output: updated } = await updateTask(
      ctx.db,
      subtask.id,
      { parentTaskId: null },
      ctx.actor,
    );

    expect(updated.parentTaskId).toBeNull();
    const reread = await getTaskByShortcode(ctx.db, subtask.id);
    expect(reread?.parentTaskId).toBeNull();
  });

  it("taskList topLevelOnly excludes subtasks, and reports correct subtask counts", async () => {
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "checklist parent" }),
      ctx.actor,
    );
    const { output: doneSub } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "sub done",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );
    await updateTask(ctx.db, doneSub.id, { status: "done" }, ctx.actor);
    const { output: openSub } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "sub open",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );

    const { data: topLevel } = await taskList(
      ctx.db,
      { topLevelOnly: true },
      [],
      { pageIndex: 0, pageSize: 500 },
    );
    const topLevelIds = topLevel.map((t) => t.id);
    expect(topLevelIds).toContain(parent.id);
    expect(topLevelIds).not.toContain(doneSub.id);
    expect(topLevelIds).not.toContain(openSub.id);

    const parentRow = topLevel.find((t) => t.id === parent.id);
    expect(parentRow?.subtaskCount).toBe(2);
    expect(parentRow?.doneSubtaskCount).toBe(1);

    const { data: subtasksOnly } = await taskList(
      ctx.db,
      { parentTaskId: parent.id },
      [],
      { pageIndex: 0, pageSize: 500 },
    );
    expect(subtasksOnly.map((t) => t.id).sort()).toEqual(
      [doneSub.id, openSub.id].sort(),
    );

    const { data: unfiltered } = await taskList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 500,
    });
    expect(unfiltered.map((task) => task.id)).toEqual(
      expect.arrayContaining([parent.id, doneSub.id, openSub.id]),
    );
  });

  it("ordinary filters reproduce the Inbox cohort", async () => {
    const { output: inbox } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "saved inbox task" }),
      ctx.actor,
    );
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "saved inbox parent" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "saved inbox subtask",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );
    const { output: completed } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "saved inbox done" }),
      ctx.actor,
    );
    await updateTask(ctx.db, completed.id, { status: "done" }, ctx.actor);
    const { output: assignedProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "saved inbox project" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "saved inbox assigned",
        projectId: assignedProject.id,
      }),
      ctx.actor,
    );

    const result = await taskList(
      ctx.db,
      {
        status: ["not_started", "later", "in_progress", "blocked"],
        projectPresenceFilter: "none",
        parentTaskPresenceFilter: "none",
      },
      [],
      { pageIndex: 0, pageSize: 500 },
    );
    expect(result.data.map((task) => task.id).sort()).toEqual(
      [inbox.id, parent.id].sort(),
    );
  });

  it("listActionableTasks excludes subtask rows, and parent rows carry subtask counts", async () => {
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "actionable parent" }),
      ctx.actor,
    );
    const { output: doneSub } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "done sub",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );
    await updateTask(ctx.db, doneSub.id, { status: "done" }, ctx.actor);
    const { output: openSub } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "open sub",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);

    expect(result.next.map((r) => r.id)).toContain(parent.id);
    expect(result.next.map((r) => r.id)).not.toContain(openSub.id);
    expect(result.later.map((r) => r.id)).not.toContain(openSub.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(openSub.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(doneSub.id);

    const parentRow = result.next.find((r) => r.id === parent.id);
    expect(parentRow?.subtaskCount).toBe(2);
    expect(parentRow?.doneSubtaskCount).toBe(1);
  });

  it("inherits the parent's subject product once, while an explicit product remains independent", async () => {
    const furnace = await createProduct(
      ctx.db,
      makeProductInput({ name: "Furnace" }),
      ctx.actor,
    );
    const airHandler = await createProduct(
      ctx.db,
      makeProductInput({ name: "Air Handler" }),
      ctx.actor,
    );
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "mechanical",
        name: "Service furnace",
        subjectProductId: furnace.id,
      }),
      ctx.actor,
    );

    const { output: inherited } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "mechanical",
        name: "Replace filter",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );
    const { output: independent } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "mechanical",
        name: "Inspect air handler",
        parentTaskId: parent.id,
        subjectProductId: airHandler.id,
      }),
      ctx.actor,
    );

    expect(inherited).toMatchObject({
      subjectProductId: furnace.id,
      subjectProductName: furnace.name,
    });
    expect(independent).toMatchObject({
      subjectProductId: airHandler.id,
      subjectProductName: airHandler.name,
    });

    const { output: cleared } = await updateTask(
      ctx.db,
      inherited.id,
      { subjectProductId: null },
      ctx.actor,
    );
    expect(cleared.subjectProductId).toBeNull();
    expect(cleared.subjectProductName).toBeNull();
  });

  it("rejects nonexistent and soft-deleted subject products", async () => {
    const bogus = unsafeProductShortcode("PRD-ZZZZ");
    await expect(
      createTask(
        ctx.db,
        taskCreateInput.parse({
          trade: "other",
          name: "Impossible product task",
          subjectProductId: bogus,
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(/product.*not found/i);

    const deleted = await createProduct(
      ctx.db,
      makeProductInput({ name: "Deleted appliance" }),
      ctx.actor,
    );
    await deleteProducts(
      ctx.db,
      [
        unsafeProductId(
          (await resolveLiveShortcode(ctx.db, deleted.id, "product"))!,
        ),
      ],
      ctx.actor,
    );

    const { output: taskWithoutProduct } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "Needs a product",
      }),
      ctx.actor,
    );
    await expect(
      updateTask(
        ctx.db,
        taskWithoutProduct.id,
        { subjectProductId: deleted.id },
        ctx.actor,
      ),
    ).rejects.toThrow(/product.*not found/i);
  });
});

describe("task repository — subject product filters and search", () => {
  const ctx = withTestDb();

  it("filters by exact product or presence and searches the linked product name", async () => {
    const furnace = await createProduct(
      ctx.db,
      makeProductInput({ name: "Basement Furnace" }),
      ctx.actor,
    );
    const { output: linked } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "mechanical",
        name: "Replace pleated media",
        subjectProductId: furnace.id,
      }),
      ctx.actor,
    );
    const { output: unlinked } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "Unrelated chore" }),
      ctx.actor,
    );
    const list = (filters: Parameters<typeof taskList>[1]) =>
      taskList(ctx.db, filters, [], { pageIndex: 0, pageSize: 500 }).then(
        ({ data }) => data.map((row) => row.id),
      );

    await expect(list({ subjectProductId: furnace.id })).resolves.toEqual([
      linked.id,
    ]);
    await expect(
      list({ subjectProductPresenceFilter: "has" }),
    ).resolves.toContain(linked.id);
    await expect(
      list({ subjectProductPresenceFilter: "none" }),
    ).resolves.toContain(unlinked.id);
    await expect(list({ search: "Basement Furnace" })).resolves.toContain(
      linked.id,
    );
  });
});

describe("task repository — projectPresenceFilter", () => {
  const ctx = withTestDb();

  const seedProjectMix = async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "presence project" }),
      ctx.actor,
    );
    for (const [name, projectId] of [
      ["filed", project.id],
      ["inbox", undefined],
    ] as const) {
      await createTask(
        ctx.db,
        taskCreateInput.parse({
          trade: "other",
          name,
          ...(projectId ? { projectId } : {}),
        }),
        ctx.actor,
      );
    }
    return project;
  };

  const listNames = async (filters: Parameters<typeof taskList>[1]) =>
    (
      await taskList(ctx.db, filters, [], { pageIndex: 0, pageSize: 500 })
    ).data.map((t) => t.name);

  it("'none' reproduces the Inbox row set", async () => {
    await seedProjectMix();
    const names = await listNames({ projectPresenceFilter: "none" });
    expect(names).toContain("inbox");
    expect(names).not.toContain("filed");
  });

  it("'has' is the complement", async () => {
    await seedProjectMix();
    const names = await listNames({ projectPresenceFilter: "has" });
    expect(names).toContain("filed");
    expect(names).not.toContain("inbox");
  });

  // buildTaskProjectCondition folds presence INTO the id condition rather than
  // adding a sibling — an AND there would make this pair match nothing.
  it("ORs with projectId instead of contradicting it", async () => {
    const project = await seedProjectMix();
    const names = await listNames({
      projectId: [project.id],
      projectPresenceFilter: "none",
    });
    expect(names).toEqual(expect.arrayContaining(["filed", "inbox"]));
  });

  // The board shares buildTaskProjectCondition but passes no presence: its
  // Inbox lane is a client-side column, so it must still see every task.
  it("leaves the board unscoped", async () => {
    await seedProjectMix();
    const board = await getTaskBoard(ctx.db, {});
    const names = board.active.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["filed", "inbox"]));
  });
});

describe("task repository — moveTasks (bulk move to project)", () => {
  const ctx = withTestDb();

  it("moves tasks to another live project", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks a" }),
      ctx.actor,
    );
    const { output: projectB, entityId: projectBId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks b" }),
      ctx.actor,
    );
    const { output: t1, entityId: t1Id } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "move me 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const { output: t2 } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "move me 2",
        projectId: projectA.id,
      }),
      ctx.actor,
    );

    const moved = await moveTasks(
      ctx.db,
      { ids: [t1.id, t2.id], projectId: projectB.id },
      ctx.actor,
    );
    expect(moved.map((t) => t.projectId)).toEqual([projectB.id, projectB.id]);

    const auditT1 = await getAuditLog(ctx.db, {
      entityType: "task",
      entityId: t1Id,
      limit: 20,
    });
    expect(
      auditT1.entries.some(
        (e) =>
          e.action === "update" &&
          // the audit trail records the column write, i.e. the uuid
          (e.changes as { projectId?: { from: unknown; to: unknown } } | null)
            ?.projectId?.to === projectBId,
      ),
    ).toBe(true);
  });

  it("moves tasks to null (the inbox)", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move to inbox project" }),
      ctx.actor,
    );
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "move to inbox",
        projectId: project.id,
      }),
      ctx.actor,
    );

    const moved = await moveTasks(
      ctx.db,
      { ids: [t.id], projectId: null },
      ctx.actor,
    );
    expect(moved.map((r) => r.projectId)).toEqual([null]);

    // No project-scoped filter distinguishes "projectless" tasks beyond a
    // plain read of projectId — assert directly against the re-read row.
    const reread = await getTaskByShortcode(ctx.db, t.id);
    expect(reread?.projectId).toBeNull();
  });

  it("rejects a nonexistent or soft-deleted target project with PROJECT_NOT_FOUND", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks reject source" }),
      ctx.actor,
    );
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "reject target",
        projectId: project.id,
      }),
      ctx.actor,
    );
    const bogusProjectId = unsafeProjectShortcode("PRJ-ZZZZ");

    await expect(
      moveTasks(ctx.db, { ids: [t.id], projectId: bogusProjectId }, ctx.actor),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PROJECT_NOT_FOUND" },
    });

    const { output: deletedProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "soon-deleted task target" }),
      ctx.actor,
    );
    await deleteProjects(ctx.db, [deletedProject.id], ctx.actor);

    await expect(
      moveTasks(
        ctx.db,
        { ids: [t.id], projectId: deletedProject.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PROJECT_NOT_FOUND" },
    });
  });

  it("leaves soft-deleted task ids in the input untouched", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks untouched a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks untouched b" }),
      ctx.actor,
    );
    const { output: live } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "still live",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const { output: deleted } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "soon deleted",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    await deleteTasks(ctx.db, [deleted.id], ctx.actor);

    const moved = await moveTasks(
      ctx.db,
      { ids: [live.id, deleted.id], projectId: projectB.id },
      ctx.actor,
    );
    expect(moved.map((t) => t.id)).toEqual([live.id]);
  });

  it("writes no audit entry for a row already in the target project (no-op)", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks noop project" }),
      ctx.actor,
    );
    const { output: t, entityId: tId } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "already there",
        projectId: project.id,
      }),
      ctx.actor,
    );

    const before = await getAuditLog(ctx.db, {
      entityType: "task",
      entityId: tId,
      limit: 20,
    });
    const beforeCount = before.entries.length;

    const moved = await moveTasks(
      ctx.db,
      { ids: [t.id], projectId: project.id },
      ctx.actor,
    );
    expect(moved.map((r) => r.projectId)).toEqual([project.id]);

    const after = await getAuditLog(ctx.db, {
      entityType: "task",
      entityId: tId,
      limit: 20,
    });
    // computeChanges sees no field diff (projectId unchanged) — moveTasks
    // logs nothing for this row, same count as before the call.
    expect(after.entries.length).toBe(beforeCount);
  });
});

describe("task repository — setTasksStatus (bulk status write)", () => {
  const ctx = withTestDb();

  it("bulk-sets status to done and to in_progress", async () => {
    const { output: t1 } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "bulk status 1" }),
      ctx.actor,
    );
    const { output: t2 } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "bulk status 2" }),
      ctx.actor,
    );

    const done = await setTasksStatus(
      ctx.db,
      { ids: [t1.id, t2.id], status: "done" },
      ctx.actor,
    );
    expect(done.map((t) => t.status)).toEqual(["done", "done"]);

    const inProgress = await setTasksStatus(
      ctx.db,
      { ids: [t1.id, t2.id], status: "in_progress" },
      ctx.actor,
    );
    expect(inProgress.map((t) => t.status)).toEqual([
      "in_progress",
      "in_progress",
    ]);
  });

  it("mixed no-op rows (already that status) don't fail, and skip the audit entry", async () => {
    const { output: already, entityId: alreadyId } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "already done",
        status: "done",
      }),
      ctx.actor,
    );
    const { output: changing, entityId: changingId } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "will change" }),
      ctx.actor,
    );

    const result = await setTasksStatus(
      ctx.db,
      { ids: [already.id, changing.id], status: "done" },
      ctx.actor,
    );
    expect(result.map((t) => t.status)).toEqual(["done", "done"]);

    const alreadyAudit = await getAuditLog(ctx.db, {
      entityType: "task",
      entityId: alreadyId,
      limit: 20,
    });
    expect(
      alreadyAudit.entries.some(
        (e) =>
          e.action === "update" &&
          (e.changes as { status?: unknown } | null)?.status !== undefined,
      ),
    ).toBe(false);

    const changingAudit = await getAuditLog(ctx.db, {
      entityType: "task",
      entityId: changingId,
      limit: 20,
    });
    expect(
      changingAudit.entries.some(
        (e) =>
          e.action === "update" &&
          (e.changes as { status?: { to: unknown } } | null)?.status?.to ===
            "done",
      ),
    ).toBe(true);
  });
});

describe("task router — bulkMove / bulkSetStatus", () => {
  const ctx = withTestDb();
  let taskCaller: ReturnType<
    typeof createTestCaller<(typeof taskRouter)["_def"]["record"]>
  >;

  beforeEach(() => {
    taskCaller = createTestCaller(taskRouter, ctx.db);
  });

  it("bulkMove returns items + sideEffects", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "router bulk move a" }),
      ctx.actor,
    );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "router bulk move b" }),
      ctx.actor,
    );
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "router move me",
        projectId: projectA.id,
      }),
      ctx.actor,
    );

    const result = await taskCaller.bulkMove({
      ids: [t.id],
      projectId: projectB.id,
    });
    expect(result.items.map((i) => i.projectId)).toEqual([projectB.id]);
    expect(result.sideEffects).toBeDefined();
  });

  it("bulkSetStatus returns items + sideEffects", async () => {
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "router status me" }),
      ctx.actor,
    );

    const result = await taskCaller.bulkSetStatus({
      ids: [t.id],
      status: "done",
    });
    expect(result.items.map((i) => i.status)).toEqual(["done"]);
    expect(result.sideEffects).toBeDefined();
  });
});

describe("task repository — getTaskSummary", () => {
  const ctx = withTestDb();

  it("computes each count via its own scope, excluding done tasks and subtasks", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "summary project" }),
      ctx.actor,
    );
    const { output: openInProject } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "open in project",
        projectId: project.id,
      }),
      ctx.actor,
    );
    const { output: inboxOpen } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "inbox open" }),
      ctx.actor,
    );
    const { output: laterTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "inbox later",
        status: "later",
      }),
      ctx.actor,
    );
    const { output: blockedTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "inbox blocked",
        status: "blocked",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "inbox done",
        status: "done",
      }),
      ctx.actor,
    );
    const { output: overdueTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "overdue",
        dueDate: householdDaysAgo(1),
      }),
      ctx.actor,
    );
    const { output: dueThisWeekTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "due this week",
        dueDate: householdDaysFromNow(3),
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "due too far out",
        dueDate: householdDaysFromNow(10),
      }),
      ctx.actor,
    );
    // A subtask of a counted top-level task — excluded from every top-level
    // count (checklist items are represented via their parent) AND from
    // next/later/blocked (listActionableTasks excludes subtask rows).
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "subtask, never counted",
        parentTaskId: openInProject.id,
      }),
      ctx.actor,
    );

    const summary = await getTaskSummary(ctx.db);

    // totalOpen: every top-level non-done task above — openInProject,
    // inboxOpen, laterTask, blockedTask, overdueTask, dueThisWeekTask, and the
    // "due too far out" task = 7 (excludes the done task and the subtask).
    expect(summary.totalOpen).toBe(7);
    // inbox: same set minus openInProject (has a projectId) = 6.
    expect(summary.inbox).toBe(6);
    expect(summary.overdue).toBe(1);
    expect(summary.dueThisWeek).toBe(1);
    // next/later/blocked mirror listActionableTasks's partitioning: laterTask
    // and blockedTask are pulled out of `next`.
    expect(summary.next).toBe(5);
    expect(summary.later).toBe(1);
    expect(summary.blocked).toBe(1);

    // Sanity-check the specific rows landed where expected via the reused
    // listActionableTasks call.
    const actionable = await listActionableTasks(ctx.db);
    expect(actionable.next.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        openInProject.id,
        inboxOpen.id,
        overdueTask.id,
        dueThisWeekTask.id,
      ]),
    );
    expect(actionable.later.map((r) => r.id)).toEqual([laterTask.id]);
    expect(actionable.blocked.map((r) => r.task.id)).toEqual([blockedTask.id]);
  });
});

describe("task repository — getTaskBoard", () => {
  const ctx = withTestDb();

  it("scopes active/recentDone/doneCount to the given project, ordering recentDone by updatedAt desc", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "board project" }),
      ctx.actor,
    );
    const { output: otherProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "board other project" }),
      ctx.actor,
    );

    const { output: active1 } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "board active 1",
        projectId: project.id,
      }),
      ctx.actor,
    );
    const { output: active2 } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "board active 2",
        projectId: project.id,
        status: "in_progress",
      }),
      ctx.actor,
    );
    const { output: doneOlder } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "board done older",
        projectId: project.id,
        status: "done",
      }),
      ctx.actor,
    );
    const { output: doneNewer } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "board done newer",
        projectId: project.id,
        status: "done",
      }),
      ctx.actor,
    );
    // Touch doneOlder after doneNewer was created, so it becomes the more
    // recently updated of the two done rows.
    await updateTask(ctx.db, doneOlder.id, { trade: "other" }, ctx.actor);

    // Out-of-scope rows — a different project's active + done task, neither
    // should appear in this project-scoped board read.
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "other project active",
        projectId: otherProject.id,
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "other project done",
        projectId: otherProject.id,
        status: "done",
      }),
      ctx.actor,
    );

    const board = await getTaskBoard(ctx.db, { projectId: project.id });

    expect(board.active.map((t) => t.id).sort()).toEqual(
      [active1.id, active2.id].sort(),
    );
    expect(board.doneCount).toBe(2);
    // Most recently updated first — doneOlder was touched after doneNewer's
    // creation, so it now sorts first.
    expect(board.recentDone.map((t) => t.id)).toEqual([
      doneOlder.id,
      doneNewer.id,
    ]);
  });

  it("filters `active` by search, and includes descendant-project tasks with includeSubProjects", async () => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "board parent project" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "board child project",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );
    const { output: inParent } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "zzz-searchable parent task",
        projectId: parent.id,
      }),
      ctx.actor,
    );
    const { output: inChild } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "child task",
        projectId: child.id,
      }),
      ctx.actor,
    );

    const withoutSubProjects = await getTaskBoard(ctx.db, {
      projectId: parent.id,
    });
    expect(withoutSubProjects.active.map((t) => t.id)).toEqual([inParent.id]);

    const withSubProjects = await getTaskBoard(ctx.db, {
      projectId: parent.id,
      includeSubProjects: true,
    });
    expect(withSubProjects.active.map((t) => t.id).sort()).toEqual(
      [inParent.id, inChild.id].sort(),
    );

    const searched = await getTaskBoard(ctx.db, {
      projectId: parent.id,
      includeSubProjects: true,
      search: "zzz-searchable",
    });
    expect(searched.active.map((t) => t.id)).toEqual([inParent.id]);
  });
});
