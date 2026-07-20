import {
  actionableTasksOut,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { taskRouter } from "~/server/api/routers/task";
import { createTestCaller } from "~/server/api/trpc";
import { createProject, updateProject } from "~/server/repo/project";
import { createTask, deleteTasks, updateTask } from "~/server/repo/task";
import { listActionableTasks } from "~/server/repo/task/actionable";

describe("task repository — listActionableTasks", () => {
  const ctx = withTestDb();

  it("an unblocked task is actionable", async () => {
    const t = await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "solo task" }),
      ctx.actor,
    );

    const result = await listActionableTasks(ctx.db);

    expect(result.actionable.map((r) => r.id)).toContain(t.id);
    expect(result.blocked.map((r) => r.task.id)).not.toContain(t.id);
  });

  it("a task blocked by an open task edge is blocked, and frees once the blocker is marked done", async () => {
    const blocker = await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "blocker task" }),
      ctx.actor,
    );
    const blocked = await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "blocked task" }),
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
      taskCreateInput.parse({ name: "manually blocked", status: "blocked" }),
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
      taskCreateInput.parse({ name: "later task", status: "later" }),
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
      taskCreateInput.parse({ name: "task c" }),
      ctx.actor,
    );
    const b = await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "task b" }),
      ctx.actor,
    );
    const a = await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "task a" }),
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
      taskCreateInput.parse({ name: "soon-deleted blocker" }),
      ctx.actor,
    );
    const blocked = await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "waiting on a deleted blocker" }),
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
      taskCreateInput.parse({ name: "done blocker" }),
      ctx.actor,
    );
    const blocked = await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "waiting on a done blocker" }),
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
      taskCreateInput.parse({ name: "router test task" }),
      ctx.actor,
    );

    const result = await taskCaller.listActionable();

    // The .output() contract must accept real repo output (pins schema<->repo).
    expect(() => actionableTasksOut.parse(result)).not.toThrow();
  });
});
