import { taskCreateInput } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fromAny } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { taskDependency } from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityMutationCommand } from "~/server/entity-kernel/contracts";
import { getDb } from "~/server/repo/database-helpers";
import { createTask, getTaskByShortcode, updateTask } from "~/server/repo/task";
import { listActionableTasks } from "~/server/repo/task/actionable";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("task repository — listActionableTasks", () => {
  const ctx = withTestDb();

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

  it("rejects a multi-hop dependency cycle without replacing prior edges", async () => {
    const { output: a } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "task cycle a" }),
      ctx.actor,
    );
    const { output: b } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "task cycle b" }),
      ctx.actor,
    );
    const { output: c } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "task cycle c" }),
      ctx.actor,
    );
    await updateTask(ctx.db, a.id, { blockedByIds: [b.id] }, ctx.actor);
    await updateTask(ctx.db, b.id, { blockedByIds: [c.id] }, ctx.actor);

    await expect(
      updateTask(ctx.db, c.id, { blockedByIds: [a.id] }, ctx.actor),
    ).rejects.toMatchObject({ reason: "DEPENDENCY_CYCLE" });
    await expect(getTaskByShortcode(ctx.db, c.id)).resolves.toMatchObject({
      blockedByIds: [],
    });
  });

  it("serializes opposite dependency writes so only one side can commit", async () => {
    const { output: a } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "dependency race a" }),
      ctx.actor,
    );
    const { output: b } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "dependency race b" }),
      ctx.actor,
    );

    const results = await Promise.allSettled([
      updateTask(ctx.db, a.id, { blockedByIds: [b.id] }, ctx.actor),
      updateTask(ctx.db, b.id, { blockedByIds: [a.id] }, ctx.actor),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { reason: "DEPENDENCY_CYCLE" } });
  });

  it("backstops task self dependency with a database CHECK", async () => {
    const { entityId } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "raw self dependency task",
      }),
      ctx.actor,
    );

    await expect(
      getDb(ctx.db).insert(taskDependency).values({
        taskId: entityId,
        blockedByTaskId: entityId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});

describe("task repository — subtasks (parentTaskId)", () => {
  const ctx = withTestDb();

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
});

// `parentTaskId` stays, for a reason the generic probe can't cover at all
// (not just a vacuity gap): it's filtered TWICE and both paths had to be
// canonicalized independently for a lowercase code to work end-to-end — see
// the comment on the case below.

describe("task kernel — bulkUpdate", () => {
  const ctx = withTestDb();
  const kernelContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  // The patch shape is exactly what is under test (including an undeclared
  // field the kernel must refuse), so the invalid case is made explicit at the
  // test-data boundary rather than weakening the production command type.
  const bulkUpdate = async <Patch extends object>(
    ids: string[],
    data: Patch,
  ) => {
    const command = fromAny<EntityMutationCommand, EntityMutationCommand>({
      action: "bulkUpdate",
      entity: "task",
      ids,
      data,
    });
    const result = await executeEntity(kernelContext(), command);
    if (result.action !== "bulkUpdate") throw new Error("unreachable");
    return result;
  };

  it("rejects a partially missing selection before changing any task", async () => {
    const { output: task } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "atomic task patch" }),
      ctx.actor,
    );

    await expect(
      bulkUpdate([task.id, testShortcode("task", "TSK-ZZZZ")], {
        status: "done",
      }),
    ).rejects.toMatchObject({ reason: "TASK_NOT_FOUND" });
    expect((await getTaskByShortcode(ctx.db, task.id))?.status).toBe(
      "not_started",
    );
  });

  it("reports a cascaded subtask as an exact deleted reference", async () => {
    const { output: parent } = await createTask(
      ctx.db,
      taskCreateInput.parse({ trade: "other", name: "delete parent" }),
      ctx.actor,
    );
    const { output: subtask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "delete child",
        parentTaskId: parent.id,
      }),
      ctx.actor,
    );

    const result = await executeEntity(kernelContext(), {
      action: "delete",
      entity: "task",
      ids: [parent.id],
    });
    if (result.action !== "delete") throw new Error("unreachable");
    expect(result.deletedReferences).toEqual(
      expect.arrayContaining([
        { entity: "task", id: parent.id },
        { entity: "task", id: subtask.id },
      ]),
    );
    expect(result.affectedEdges).toEqual(
      expect.arrayContaining([
        {
          edge: "Task.parentTaskId",
          effect: "soft-delete",
          changed: 1,
        },
        {
          edge: "TaskDependency.taskId",
          effect: "hard-delete",
          changed: 0,
        },
        {
          edge: "TaskDependency.blockedByTaskId",
          effect: "hard-delete",
          changed: 0,
        },
      ]),
    );
  });

  it("refuses half a due-date window rather than nulling the other half", async () => {
    const { output: t } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "kernel due window",
        dueDate: "2024-03-01",
        dueEndDate: "2024-03-05",
      }),
      ctx.actor,
    );

    await expect(
      bulkUpdate([t.id], { dueDate: "2024-04-01" }),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    expect((await getTaskByShortcode(ctx.db, t.id))?.dueEndDate).toBe(
      "2024-03-05",
    );

    expect(
      (
        await bulkUpdate([t.id], {
          dueDate: "2024-04-01",
          dueEndDate: "2024-04-03",
        })
      ).updatedReferences,
    ).toEqual([{ entity: "task", id: t.id }]);
  });
});
