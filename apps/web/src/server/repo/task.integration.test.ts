import { unsafeProjectId, unsafeTaskId } from "@cubby/schemas/identifiers";
import {
  actionableTasksOut,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { taskRouter } from "~/server/api/routers/task";
import { createTestCaller } from "~/server/api/trpc";
import { getAuditLog } from "~/server/repo/audit-log";
import {
  createProject,
  deleteProjects,
  updateProject,
} from "~/server/repo/project";
import {
  createTask,
  deleteTasks,
  getTaskByID,
  moveTasks,
  setTasksStatus,
  taskList,
  updateTask,
} from "~/server/repo/task";
import { listActionableTasks } from "~/server/repo/task/actionable";

describe("task repository — listActionableTasks", () => {
  const ctx = withTestDb();

  it("an unblocked task is actionable", async () => {
    const t = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "solo task" }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);

    expect(result.actionable.map((r) => r.id)).toContain(t.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(t.id);
  });

  it("a task blocked by an open task edge is blocked, and frees once the blocker is marked done", async () => {
    const blocker = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "blocker task" }),
      ctx.actor,
    );
    const blocked = await createTask(
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
    expect(beforeDone.actionable.map((r) => r.id)).not.toContain(blocked.id);

    await updateTask(ctx.db, blocker.id, { status: "done" }, ctx.actor);

    const afterDone = await listActionableTasks(ctx.db);
    expect(afterDone.actionable.map((r) => r.id)).toContain(blocked.id);
    expect(afterDone.blocked.map((r) => r.task.id)).not.toContain(blocked.id);
  });

  it("a project-edge blockage is inherited by the project's tasks", async () => {
    const blockerProject = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "blocker project" }),
      ctx.actor,
    );
    const project = await createProject(
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
    const t = await createTask(
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
    const t = await createTask(
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
    expect(result.actionable.map((r) => r.id)).not.toContain(t.id);
  });

  it("a later task with no blockers is actionable, with isLater true", async () => {
    const t = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "later task",
        status: "later",
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);
    const row = result.actionable.find((r) => r.id === t.id);

    expect(row).toBeDefined();
    expect(row?.isLater).toBe(true);
  });

  it("builds the transitive chain (A blocked by B, B blocked by C -> A's chain = [B, C])", async () => {
    const c = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "task c" }),
      ctx.actor,
    );
    const b = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "task b" }),
      ctx.actor,
    );
    const a = await createTask(
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
    const blocker = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "soon-deleted blocker" }),
      ctx.actor,
    );
    const blocked = await createTask(
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

    expect(result.actionable.map((r) => r.id)).toContain(blocked.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(blocked.id);
  });

  it("a done blocker does not block", async () => {
    const blocker = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "done blocker" }),
      ctx.actor,
    );
    const blocked = await createTask(
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

    expect(result.actionable.map((r) => r.id)).toContain(blocked.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(blocked.id);
  });

  it("a task in a grandchild project is blocked when the ROOT ancestor has an open blocked-by edge", async () => {
    const blockerProject = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "root blocker project" }),
      ctx.actor,
    );
    const root = await createProject(
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
    const child = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "child project",
        parentProjectId: root.id,
      }),
      ctx.actor,
    );
    const grandchild = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "grandchild project",
        parentProjectId: child.id,
      }),
      ctx.actor,
    );
    const t = await createTask(
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
    expect(result.actionable.map((r) => r.id)).not.toContain(t.id);

    // Unblocked once the root ancestor's blocker is marked done.
    await updateProject(
      ctx.db,
      blockerProject.id,
      { status: "done" },
      ctx.actor,
    );
    const afterDone = await listActionableTasks(ctx.db);
    expect(afterDone.actionable.map((r) => r.id)).toContain(t.id);
    expect(afterDone.blocked.map((r) => r.task.id)).not.toContain(t.id);
  });

  it("a done intermediate ancestor's own blocked-by edges don't block", async () => {
    const blockerProject = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "intermediate blocker project" }),
      ctx.actor,
    );
    const root = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "root project two" }),
      ctx.actor,
    );
    const child = await createProject(
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
    const grandchild = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "grandchild under done intermediate",
        parentProjectId: child.id,
      }),
      ctx.actor,
    );
    const t = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "task under a done intermediate ancestor",
        projectId: grandchild.id,
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);

    expect(result.actionable.map((r) => r.id)).toContain(t.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(t.id);
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
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "subtask project" }),
      ctx.actor,
    );
    const parent = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "parent task",
        projectId: project.id,
      }),
      ctx.actor,
    );

    const subtask = await createTask(
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
    const parentProject = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "parent project" }),
      ctx.actor,
    );
    const otherProject = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "other project" }),
      ctx.actor,
    );
    const parent = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "parent task",
        projectId: parentProject.id,
      }),
      ctx.actor,
    );

    const subtask = await createTask(
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
    const grandparent = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "grandparent" }),
      ctx.actor,
    );
    const parent = await createTask(
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
    const futureSubtask = await createTask(
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
    const otherTask = await createTask(
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
    const t = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "self parent" }),
      ctx.actor,
    );

    await expect(
      updateTask(ctx.db, t.id, { parentTaskId: t.id }, ctx.actor),
    ).rejects.toThrow(/cannot be its own parent/i);
  });

  it("rejects a nonexistent parent (create and update)", async () => {
    const bogus = unsafeTaskId("00000000-0000-0000-0000-000000000000");

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

    const t = await createTask(
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
    const parent = await createTask(
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
    const parent = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "parent" }),
      ctx.actor,
    );
    const subtask = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "subtask",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );

    const updated = await updateTask(
      ctx.db,
      subtask.id,
      { parentTaskId: null },
      ctx.actor,
    );

    expect(updated.parentTaskId).toBeNull();
    const reread = await getTaskByID(ctx.db, subtask.id);
    expect(reread.parentTaskId).toBeNull();
  });

  it("taskList topLevelOnly excludes subtasks, and reports correct subtask counts", async () => {
    const parent = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "checklist parent" }),
      ctx.actor,
    );
    const doneSub = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "sub done",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );
    await updateTask(ctx.db, doneSub.id, { status: "done" }, ctx.actor);
    const openSub = await createTask(
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
  });

  it("listActionableTasks excludes subtask rows, and parent rows carry subtask counts", async () => {
    const parent = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "actionable parent" }),
      ctx.actor,
    );
    const doneSub = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "done sub",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );
    await updateTask(ctx.db, doneSub.id, { status: "done" }, ctx.actor);
    const openSub = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "open sub",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);

    expect(result.actionable.map((r) => r.id)).toContain(parent.id);
    expect(result.actionable.map((r) => r.id)).not.toContain(openSub.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(openSub.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(doneSub.id);

    const parentRow = result.actionable.find((r) => r.id === parent.id);
    expect(parentRow?.subtaskCount).toBe(2);
    expect(parentRow?.doneSubtaskCount).toBe(1);
  });
});

describe("task repository — moveTasks (bulk move to project)", () => {
  const ctx = withTestDb();

  it("moves tasks to another live project", async () => {
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks b" }),
      ctx.actor,
    );
    const t1 = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "move me 1",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const t2 = await createTask(
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
      entityId: t1.id,
      limit: 20,
    });
    expect(
      auditT1.entries.some(
        (e) =>
          e.action === "update" &&
          (e.changes as { projectId?: { from: unknown; to: unknown } } | null)
            ?.projectId?.to === projectB.id,
      ),
    ).toBe(true);
  });

  it("moves tasks to null (the inbox)", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move to inbox project" }),
      ctx.actor,
    );
    const t = await createTask(
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
    const reread = await getTaskByID(ctx.db, t.id);
    expect(reread.projectId).toBeNull();
  });

  it("rejects a nonexistent or soft-deleted target project with PROJECT_NOT_FOUND", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks reject source" }),
      ctx.actor,
    );
    const t = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "reject target",
        projectId: project.id,
      }),
      ctx.actor,
    );
    const bogusProjectId = unsafeProjectId(
      "00000000-0000-0000-0000-000000000000",
    );

    await expect(
      moveTasks(ctx.db, { ids: [t.id], projectId: bogusProjectId }, ctx.actor),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PROJECT_NOT_FOUND" },
    });

    const deletedProject = await createProject(
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
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks untouched a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks untouched b" }),
      ctx.actor,
    );
    const live = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "still live",
        projectId: projectA.id,
      }),
      ctx.actor,
    );
    const deleted = await createTask(
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
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "move tasks noop project" }),
      ctx.actor,
    );
    const t = await createTask(
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
      entityId: t.id,
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
      entityId: t.id,
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
    const t1 = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "bulk status 1" }),
      ctx.actor,
    );
    const t2 = await createTask(
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
    const already = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "already done",
        status: "done",
      }),
      ctx.actor,
    );
    const changing = await createTask(
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
      entityId: already.id,
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
      entityId: changing.id,
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
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "router bulk move a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "router bulk move b" }),
      ctx.actor,
    );
    const t = await createTask(
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
    const t = await createTask(
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
