import {
  taskBoardOut,
  type TaskFilters,
  taskFiltersSchema,
} from "@cubby/schemas/project";
import { CURRENT_MEMBER_FILTER } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { ledgerParty } from "~/server/db/schema";
import { resolveCurrentMemberFilters } from "~/server/entity-kernel/current-member-filter";
import { taskHandlers } from "~/server/operations/task.server";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { getDb } from "./database-helpers";
import { updateLedgerParty } from "./ledger-party";
import { getProjectByID, updateProject } from "./project/crud";
import { listActionableTasks } from "./task/actionable";
import { getTaskByShortcode, updateTask } from "./task/crud";
import { taskList } from "./task/lookup";

describe("member assignee inheritance", () => {
  const ctx = withTestDb();
  it("resolves defaults live, protects explicit None, clears reset overrides, and preserves detached assignments", async () => {
    const first = await createRepoEntity(ctx, "ledgerParty", {
      name: "First member",
      kind: "member",
    });
    const second = await createRepoEntity(ctx, "ledgerParty", {
      name: "Second member",
      kind: "member",
    });
    const project = await createRepoEntity(ctx, "project", {
      name: "Assigned project",
      defaultTrade: "building",
      assigneeId: first.output.id,
    });
    const childProject = await createRepoEntity(ctx, "project", {
      name: "Child project",
      parentProjectId: project.output.id,
    });
    const parent = await createRepoEntity(ctx, "task", {
      name: "Parent work",
      projectId: childProject.output.id,
    });
    const child = await createRepoEntity(ctx, "task", {
      name: "Child work",
      parentTaskId: parent.output.id,
    });
    const read = () => getTaskByShortcode(ctx.db, child.output.id);
    expect(await read()).toMatchObject({
      assigneeId: first.output.id,
      assigneeName: "First member",
      fieldResolutions: { assigneeId: { mode: "inherit" } },
    });
    await updateProject(
      ctx.db,
      childProject.output.id,
      { assigneeId: null },
      ctx.actor,
    );
    expect(await read()).toMatchObject({ assigneeId: null });
    await updateProject(
      ctx.db,
      childProject.output.id,
      { assigneeMode: "inherit" },
      ctx.actor,
    );
    const otherParent = await createRepoEntity(ctx, "task", {
      name: "Other parent",
      trade: "building",
      assigneeId: second.output.id,
    });
    await updateTask(
      ctx.db,
      child.output.id,
      { parentTaskId: otherParent.output.id },
      ctx.actor,
    );
    expect(await read()).toMatchObject({ assigneeId: second.output.id });
    await updateTask(
      ctx.db,
      child.output.id,
      { parentTaskId: parent.output.id },
      ctx.actor,
    );
    await updateTask(ctx.db, child.output.id, { assigneeId: null }, ctx.actor);
    expect(await read()).toMatchObject({
      assigneeId: null,
      fieldResolutions: { assigneeId: { mode: "none" } },
    });
    await updateTask(
      ctx.db,
      child.output.id,
      { assigneeId: second.output.id },
      ctx.actor,
    );
    await updateTask(
      ctx.db,
      child.output.id,
      { assigneeMode: "inherit" },
      ctx.actor,
    );
    await updateProject(
      ctx.db,
      project.output.id,
      { assigneeId: second.output.id },
      ctx.actor,
    );
    expect(await read()).toMatchObject({
      assigneeId: second.output.id,
      fieldResolutions: { assigneeId: { storedValue: null } },
    });
    await updateTask(ctx.db, parent.output.id, { assigneeId: null }, ctx.actor);
    expect(await read()).toMatchObject({ assigneeId: null });
    await updateTask(
      ctx.db,
      parent.output.id,
      { assigneeMode: "inherit" },
      ctx.actor,
    );
    await updateTask(
      ctx.db,
      child.output.id,
      { parentTaskId: null },
      ctx.actor,
    );
    await updateProject(
      ctx.db,
      project.output.id,
      { assigneeId: first.output.id },
      ctx.actor,
    );
    expect(await read()).toMatchObject({
      assigneeId: second.output.id,
      fieldResolutions: { assigneeId: { mode: "explicit" } },
    });
    await updateProject(
      ctx.db,
      childProject.output.id,
      { parentProjectId: null },
      ctx.actor,
    );
    await updateProject(
      ctx.db,
      project.output.id,
      { assigneeId: second.output.id },
      ctx.actor,
    );
    expect(await getProjectByID(ctx.db, childProject.entityId)).toMatchObject({
      assigneeId: first.output.id,
    });
  });
  it("rejects nonmember references and filters by effective assignee rather than stored overrides", async () => {
    const member = await createRepoEntity(ctx, "ledgerParty", {
      name: "Member",
      kind: "member",
    });
    const guest = await createRepoEntity(ctx, "ledgerParty", {
      name: "Guest",
      kind: "guest",
    });
    const project = await createRepoEntity(ctx, "project", {
      name: "Filtered project",
      defaultTrade: "building",
      assigneeId: member.output.id,
    });
    const task = await createRepoEntity(ctx, "task", {
      name: "Inherited work",
      projectId: project.output.id,
    });
    await expect(
      updateTask(
        ctx.db,
        task.output.id,
        { assigneeId: guest.output.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    await expect(
      updateProject(
        ctx.db,
        project.output.id,
        { assigneeId: guest.output.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    await expect(
      updateLedgerParty(ctx.db, member.output.id, { kind: "guest" }, ctx.actor),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    const page = await taskList(
      ctx.db,
      { assigneeId: [member.output.id] },
      [],
      { pageIndex: 0, pageSize: 20 },
    );
    expect(page.data.map((row) => row.id)).toContain(task.output.id);
    const earlier = await createRepoEntity(ctx, "ledgerParty", {
      name: "A member",
      kind: "member",
    });
    const explicit = await createRepoEntity(ctx, "task", {
      name: "Explicit work",
      trade: "building",
      assigneeId: earlier.output.id,
    });
    const sorted = await taskList(
      ctx.db,
      {},
      [{ orderBy: "assigneeId", direction: "asc" }],
      { pageIndex: 0, pageSize: 20 },
    );
    expect(sorted.data.map((row) => row.id)).toEqual([
      explicit.output.id,
      task.output.id,
    ]);
    // `@me` resolves to the actor's linked member; an unlinked actor matches
    // nothing rather than dropping the filter.
    const me = (filters: TaskFilters) =>
      resolveCurrentMemberFilters(
        { db: ctx.db, actorContext: ctx.actor },
        taskFiltersSchema,
        filters,
      );
    const beforeLink = await taskList(
      ctx.db,
      await me({ assigneeId: [CURRENT_MEMBER_FILTER] }),
      [],
      { pageIndex: 0, pageSize: 20 },
    );
    expect(beforeLink.data).toEqual([]);
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.id, member.entityId));
    const mine = await taskList(
      ctx.db,
      await me({ assigneeId: [CURRENT_MEMBER_FILTER] }),
      [],
      { pageIndex: 0, pageSize: 20 },
    );
    expect(mine.data.map((row) => row.id)).toContain(task.output.id);
    // Reads outside the kernel resolve `@me` at the operation boundary.
    const board = taskBoardOut.parse(
      await taskHandlers.runs.board!.run(
        {
          ...requireActor(
            createTestRequestContext(ctx.db, {
              auth: { userId: ctx.actor.userId },
            }),
          ),
          signal: new AbortController().signal,
        },
        { assigneeId: [CURRENT_MEMBER_FILTER] },
      ),
    );
    expect(board.active.map((row) => row.id)).toContain(task.output.id);
    // Only Ledger Party filters resolve; a text search for "@me" stays text.
    const searched = await me({
      search: CURRENT_MEMBER_FILTER,
      assigneeId: [CURRENT_MEMBER_FILTER],
    });
    expect(searched.search).toBe(CURRENT_MEMBER_FILTER);
    expect(searched.assigneeId).toEqual([member.output.id]);
    expect(mine.data.map((row) => row.id)).not.toContain(explicit.output.id);
    const mineOrEarlier = await taskList(
      ctx.db,
      await me({ assigneeId: [CURRENT_MEMBER_FILTER, earlier.output.id] }),
      [],
      { pageIndex: 0, pageSize: 20 },
    );
    expect(mineOrEarlier.data.map((row) => row.id)).toEqual(
      expect.arrayContaining([task.output.id, explicit.output.id]),
    );
    const actionable = await listActionableTasks(
      ctx.db,
      await me({ assigneeId: [CURRENT_MEMBER_FILTER] }),
    );
    expect(actionable.next.map((row) => row.id)).toContain(task.output.id);
    const unassigned = await taskList(
      ctx.db,
      { assigneePresenceFilter: "none" },
      [],
      { pageIndex: 0, pageSize: 20 },
    );
    expect(unassigned.data.map((row) => row.id)).not.toContain(task.output.id);
  });
});
