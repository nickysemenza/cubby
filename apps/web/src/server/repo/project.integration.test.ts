import {
  type ProjectId,
  unsafeProjectId,
  unsafeProjectShortcode,
} from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import type {
  ExpenseCreateInput,
  ProjectCreateInput,
} from "@cubby/schemas/project";
import {
  expenseCreateInput,
  LIVE_PROJECT_STATUSES,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { eq, or } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  image,
  project,
  projectDependency,
  projectImage,
} from "~/server/db/schema";
import { getAuditLog } from "./audit-log";
import { getDb, insertAndReturn } from "./database-helpers";
import { createExpense, expenseList } from "./expense";
import {
  computeAttentionItems,
  createProject,
  deleteProjects,
  getProjectByID,
  projectDashboardSummary,
  projectList,
  projectNameOptions,
  projectPortfolioAnalytics,
  projectTreePage,
  updateProject,
} from "./project";
import { EMPTY_PROJECT_CONTENT_DATES } from "./project/helpers";
import {
  aggregateSubtreeDates,
  type ProjectParentRow,
} from "./project/subtree";
import { createTask, taskList, updateTask } from "./task";

describe("project repository", () => {
  const ctx = withTestDb();

  it("creates a project and surfaces it in the list", async () => {
    const { output: created } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "test project a",
        icon: "🏡",
        status: "in_progress",
        locations: ["Cabin"],
      }),
      ctx.actor,
    );

    expect(created.name).toBe("test project a");
    expect(created.status).toBe("in_progress");
    expect(created.locations).toEqual(["Cabin"]);
    await expect(projectNameOptions(ctx.db)).resolves.toContainEqual(
      expect.objectContaining({
        id: created.id,
        name: "test project a",
        icon: "🏡",
      }),
    );
    expect(created.rollup).toEqual({
      spent: 0,
      actualSpent: 0,
      committedSpent: 0,
      contributions: 0,
      expenseCount: 0,
      taskCount: 0,
      doneTaskCount: 0,
      subtree: {
        spent: 0,
        actualSpent: 0,
        committedSpent: 0,
        contributions: 0,
        expenseCount: 0,
        taskCount: 0,
        doneTaskCount: 0,
        projectCount: 0,
        costEstimate: null,
      },
    });

    const { data, count } = await projectList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 10,
    });
    expect(count).toBe(1);
    expect(data.map((p) => p.id)).toEqual([created.id]);
  });

  it("creates, reads, updates, clears, and audits project resource URLs", async () => {
    const driveUrl =
      "https://drive.google.com/drive/folders/create123?usp=sharing";
    const notionUrl =
      "https://www.notion.so/workspace/Create-0123456789abcdef?pvs=4";
    const { output: created, entityId: createdEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "project resource links",
        googleDriveFolderUrl: driveUrl,
        notionPageUrl: notionUrl,
      }),
      ctx.actor,
    );

    expect(created).toMatchObject({
      googleDriveFolderUrl: driveUrl,
      notionPageUrl: notionUrl,
    });
    await expect(
      getProjectByID(ctx.db, createdEntityId),
    ).resolves.toMatchObject({
      googleDriveFolderUrl: driveUrl,
      notionPageUrl: notionUrl,
    });

    const updatedDriveUrl =
      "https://drive.google.com/drive/u/1/folders/update456?resourcekey=key";
    const updatedNotionUrl =
      "https://cubby.notion.site/Update-0123456789abcdef#details";
    const { output: updated } = await updateProject(
      ctx.db,
      created.id,
      {
        googleDriveFolderUrl: updatedDriveUrl,
        notionPageUrl: updatedNotionUrl,
      },
      ctx.actor,
    );
    expect(updated).toMatchObject({
      googleDriveFolderUrl: updatedDriveUrl,
      notionPageUrl: updatedNotionUrl,
    });

    const { output: cleared } = await updateProject(
      ctx.db,
      created.id,
      { googleDriveFolderUrl: null, notionPageUrl: null },
      ctx.actor,
    );
    expect(cleared).toMatchObject({
      googleDriveFolderUrl: null,
      notionPageUrl: null,
    });

    const audit = await getAuditLog(ctx.db, {
      entityType: "project",
      entityId: createdEntityId,
      limit: 20,
    });
    const updateChanges = audit.entries
      .filter((entry) => entry.action === "update")
      .map((entry) => entry.changes);
    expect(updateChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          googleDriveFolderUrl: {
            from: driveUrl,
            to: updatedDriveUrl,
          },
          notionPageUrl: {
            from: notionUrl,
            to: updatedNotionUrl,
          },
        }),
        expect.objectContaining({
          googleDriveFolderUrl: {
            from: updatedDriveUrl,
            to: null,
          },
          notionPageUrl: {
            from: updatedNotionUrl,
            to: null,
          },
        }),
      ]),
    );
  });

  it("filters the list by location (ANY over the free-form locations[] column)", async () => {
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "test project cabin",
        locations: ["Cabin"],
      }),
      ctx.actor,
    );
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "test project lake",
        locations: ["Lake House"],
      }),
      ctx.actor,
    );

    const { data } = await projectList(ctx.db, { location: "Cabin" }, [], {
      pageIndex: 0,
      pageSize: 10,
    });
    expect(data.map((p) => p.name)).toEqual(["test project cabin"]);
  });

  it("rolls up spend (including future expenses) and task counts", async () => {
    const { output: project, entityId: projectEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project rollup" }),
      ctx.actor,
    );

    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "test expense made",
        projectId: project.id,
        cost: 100,
        future: false,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "test expense future",
        projectId: project.id,
        cost: 50,
        future: true,
      }),
      ctx.actor,
    );

    const { output: doneTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "test task done",
        projectId: project.id,
        status: "not_started",
      }),
      ctx.actor,
    );
    await updateTask(ctx.db, doneTask.id, { status: "done" }, ctx.actor);
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "test task two",
        projectId: project.id,
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "test task three",
        projectId: project.id,
      }),
      ctx.actor,
    );

    const result = await getProjectByID(ctx.db, projectEntityId);
    // spent includes the future expense — matches the retired Notion rollup's
    // semantics (a planned spend still counts toward the running total).
    // subtree equals own here — this project is a leaf (no sub-projects).
    expect(result.rollup).toEqual({
      spent: 150,
      actualSpent: 100,
      committedSpent: 50,
      contributions: 0,
      expenseCount: 2,
      taskCount: 3,
      doneTaskCount: 1,
      subtree: {
        spent: 150,
        actualSpent: 100,
        committedSpent: 50,
        contributions: 0,
        expenseCount: 2,
        taskCount: 3,
        doneTaskCount: 1,
        projectCount: 0,
        costEstimate: null,
      },
    });
  });

  it("replaces the blockedByIds dependency set on update, both directions readable", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project a" }),
      ctx.actor,
    );
    const { output: projectB, entityId: projectBEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "test project b" }),
        ctx.actor,
      );
    const { output: projectC, entityId: projectCEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "test project c" }),
        ctx.actor,
      );

    const { output: updatedA } = await updateProject(
      ctx.db,
      projectA.id,
      { blockedByIds: [projectB.id, projectC.id] },
      ctx.actor,
    );
    expect(new Set(updatedA.blockedByIds)).toEqual(
      new Set([projectB.id, projectC.id]),
    );

    const projectBAfter = await getProjectByID(ctx.db, projectBEntityId);
    expect(projectBAfter.blockingIds).toEqual([projectA.id]);

    // Replace the set (drop C, keep B) — full replacement, not an append.
    const { output: updatedAgain } = await updateProject(
      ctx.db,
      projectA.id,
      { blockedByIds: [projectB.id] },
      ctx.actor,
    );
    expect(updatedAgain.blockedByIds).toEqual([projectB.id]);

    const projectCAfter = await getProjectByID(ctx.db, projectCEntityId);
    expect(projectCAfter.blockingIds).toEqual([]);
  });

  it("rejects a self-reference in blockedByIds", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project self-ref" }),
      ctx.actor,
    );

    await expect(
      updateProject(
        ctx.db,
        projectA.id,
        { blockedByIds: [projectA.id] },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("dedupes duplicate ids in blockedByIds down to a single edge", async () => {
    const { output: projectA, entityId: projectAEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "test project dedupe a" }),
        ctx.actor,
      );
    const { output: projectB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project dedupe b" }),
      ctx.actor,
    );

    const { output: updated } = await updateProject(
      ctx.db,
      projectA.id,
      { blockedByIds: [projectB.id, projectB.id] },
      ctx.actor,
    );
    expect(updated.blockedByIds).toEqual([projectB.id]);

    const edges = await getDb(ctx.db)
      .select()
      .from(projectDependency)
      .where(eq(projectDependency.projectId, projectAEntityId));
    expect(edges).toHaveLength(1);
  });

  it("rejects a nonexistent id in blockedByIds with NOT_FOUND (not a raw 500)", async () => {
    const { output: projectA } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project missing dep" }),
      ctx.actor,
    );
    const missingId = unsafeProjectShortcode("PRJ-9999");

    await expect(
      updateProject(
        ctx.db,
        projectA.id,
        { blockedByIds: [missingId] },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("soft-deletes project images when the project is deleted", async () => {
    const { output: projectWithImage, entityId: projectWithImageEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "test project with image" }),
        ctx.actor,
      );
    const img = await insertAndReturn(ctx.db, image, {
      key: "test-project-image-key",
      url: "https://example.com/test-project-image.jpg",
      filename: "test-project-image.jpg",
      contentType: "image/jpeg",
      size: 100,
      status: "UPLOADED",
    });
    const projImg = await insertAndReturn(ctx.db, projectImage, {
      projectId: projectWithImageEntityId,
      imageId: img.id,
    });

    await deleteProjects(ctx.db, [projectWithImage.id], ctx.actor);

    const after = await getDb(ctx.db).query.projectImage.findFirst({
      where: eq(projectImage.id, projImg.id),
    });
    expect(after?.deletedAt).not.toBeNull();
  });

  it("blocks deletion while live tasks or expenses still reference the project", async () => {
    const { output: projectWithTask } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project with task" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "test task blocking delete",
        projectId: projectWithTask.id,
      }),
      ctx.actor,
    );
    await expect(
      deleteProjects(ctx.db, [projectWithTask.id], ctx.actor),
    ).rejects.toThrow(/still have tasks/);

    const { output: projectWithExpense } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project with expense" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "test expense blocking delete",
        projectId: projectWithExpense.id,
      }),
      ctx.actor,
    );
    await expect(
      deleteProjects(ctx.db, [projectWithExpense.id], ctx.actor),
    ).rejects.toThrow(/still have expenses/);
  });

  it("hard-deletes dependency edges (both directions) when a project is deleted", async () => {
    const { output: projectA, entityId: projectAEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "test project a" }),
        ctx.actor,
      );
    const { output: projectB, entityId: projectBEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "test project b" }),
        ctx.actor,
      );
    await updateProject(
      ctx.db,
      projectA.id,
      { blockedByIds: [projectB.id] },
      ctx.actor,
    );

    // B has no tasks/expenses, so deleting it is allowed even though A still
    // references it — the dependency edge is hard-deleted, not a delete guard.
    await deleteProjects(ctx.db, [projectB.id], ctx.actor);

    const remainingEdges = await getDb(ctx.db)
      .select()
      .from(projectDependency)
      .where(
        or(
          eq(projectDependency.projectId, projectBEntityId),
          eq(projectDependency.blockedByProjectId, projectBEntityId),
        ),
      );
    expect(remainingEdges).toHaveLength(0);

    const projectAAfter = await getProjectByID(ctx.db, projectAEntityId);
    expect(projectAAfter.blockedByIds).toEqual([]);
  });
});

describe("project repository — sub-projects (parentProjectId)", () => {
  const ctx = withTestDb();

  it("sets, changes, and clears parentProjectId", async () => {
    const { output: parentA, entityId: parentAEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "parent a" }),
      ctx.actor,
    );
    const { output: parentB } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "parent b" }),
      ctx.actor,
    );

    const { output: created } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "child at create",
        parentProjectId: parentA.id,
      }),
      ctx.actor,
    );
    expect(created.parentProjectId).toBe(parentA.id);
    expect(created.parentProjectName).toBe(parentA.name);

    const parentAAfter = await getProjectByID(ctx.db, parentAEntityId);
    expect(parentAAfter.childProjectIds).toEqual([created.id]);

    const { output: changed } = await updateProject(
      ctx.db,
      created.id,
      { parentProjectId: parentB.id },
      ctx.actor,
    );
    expect(changed.parentProjectId).toBe(parentB.id);
    expect(changed.parentProjectName).toBe(parentB.name);

    const parentAAfterMove = await getProjectByID(ctx.db, parentAEntityId);
    expect(parentAAfterMove.childProjectIds).toEqual([]);

    const { output: cleared } = await updateProject(
      ctx.db,
      created.id,
      { parentProjectId: null },
      ctx.actor,
    );
    expect(cleared.parentProjectId).toBeNull();
    expect(cleared.parentProjectName).toBeNull();
  });

  it("rejects a nonexistent or soft-deleted parentProjectId with NOT_FOUND", async () => {
    const missingId = unsafeProjectShortcode("PRJ-9999");
    await expect(
      createProject(
        ctx.db,
        projectCreateInput.parse({
          name: "orphan create",
          parentProjectId: missingId,
        }),
        ctx.actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project not-found parent" }),
      ctx.actor,
    );
    const { output: deletedParent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "soon-deleted parent" }),
      ctx.actor,
    );
    await deleteProjects(ctx.db, [deletedParent.id], ctx.actor);

    await expect(
      updateProject(
        ctx.db,
        project.id,
        { parentProjectId: deletedParent.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a self-parent with SELF_DEPENDENCY", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project self-parent" }),
      ctx.actor,
    );

    await expect(
      updateProject(
        ctx.db,
        project.id,
        { parentProjectId: project.id },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a cycle (A -> B -> C; making A a child of C) with PROJECT_CYCLE", async () => {
    const { output: a, entityId: aEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "cycle a" }),
      ctx.actor,
    );
    const { output: b } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "cycle b", parentProjectId: a.id }),
      ctx.actor,
    );
    const { output: c } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "cycle c", parentProjectId: b.id }),
      ctx.actor,
    );

    // C is a descendant of A — making A a child of C would create a cycle.
    await expect(
      updateProject(ctx.db, a.id, { parentProjectId: c.id }, ctx.actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Unaffected: the original chain still holds.
    const aAfter = await getProjectByID(ctx.db, aEntityId);
    expect(aAfter.parentProjectId).toBeNull();
  });

  it("rejects deletion while live child projects still reference the parent, succeeds once reparented away", async () => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "parent with child" }),
      ctx.actor,
    );
    const { output: child, entityId: childEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "child blocking delete",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );

    await expect(
      deleteProjects(ctx.db, [parent.id], ctx.actor),
    ).rejects.toThrow(/still have sub-projects/);

    // Reparent the child away, then the delete succeeds — no cascade.
    await updateProject(ctx.db, child.id, { parentProjectId: null }, ctx.actor);
    await deleteProjects(ctx.db, [parent.id], ctx.actor);

    const parentAfter = await getProjectByID(ctx.db, childEntityId).catch(
      (e) => e,
    );
    expect(parentAfter).toBeDefined();
  });

  it("accumulates subtree rollups over 3 levels; a leaf's subtree equals its own numbers", async () => {
    const { output: grandparent, entityId: grandparentEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "subtree grandparent" }),
        ctx.actor,
      );
    const { output: parent, entityId: parentEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "subtree parent",
        parentProjectId: grandparent.id,
      }),
      ctx.actor,
    );
    const { output: leaf, entityId: leafEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "subtree leaf",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );

    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "grandparent expense",
        projectId: grandparent.id,
        cost: 10,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "parent expense",
        projectId: parent.id,
        cost: 20,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "leaf expense",
        projectId: leaf.id,
        cost: 40,
      }),
      ctx.actor,
    );

    const { output: leafDoneTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "leaf done task",
        projectId: leaf.id,
      }),
      ctx.actor,
    );
    await updateTask(ctx.db, leafDoneTask.id, { status: "done" }, ctx.actor);
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "leaf open task",
        projectId: leaf.id,
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "parent task",
        projectId: parent.id,
      }),
      ctx.actor,
    );

    const leafAfter = await getProjectByID(ctx.db, leafEntityId);
    expect(leafAfter.rollup.subtree).toEqual({
      spent: leafAfter.rollup.spent,
      actualSpent: leafAfter.rollup.actualSpent,
      committedSpent: leafAfter.rollup.committedSpent,
      contributions: leafAfter.rollup.contributions,
      expenseCount: leafAfter.rollup.expenseCount,
      taskCount: leafAfter.rollup.taskCount,
      doneTaskCount: leafAfter.rollup.doneTaskCount,
      projectCount: 0,
      costEstimate: leafAfter.costEstimate,
    });
    expect(leafAfter.rollup.subtree.spent).toBe(40);

    const parentAfter = await getProjectByID(ctx.db, parentEntityId);
    expect(parentAfter.rollup.subtree).toEqual({
      spent: 60, // 20 (own) + 40 (leaf)
      actualSpent: 60, // all non-future, positive
      committedSpent: 0,
      contributions: 0,
      expenseCount: 2,
      taskCount: 3, // 1 own + 2 leaf
      doneTaskCount: 1,
      projectCount: 1, // leaf
      costEstimate: null,
    });

    const grandparentAfter = await getProjectByID(ctx.db, grandparentEntityId);
    expect(grandparentAfter.rollup.subtree).toEqual({
      spent: 70, // 10 (own) + 20 (parent) + 40 (leaf)
      actualSpent: 70,
      committedSpent: 0,
      contributions: 0,
      expenseCount: 3,
      taskCount: 3,
      doneTaskCount: 1,
      projectCount: 2, // parent + leaf
      costEstimate: null,
    });

    // The list path aggregates the same way (batched over a page, not just
    // the single-project reader).
    const { data } = await projectList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    const grandparentRow = data.find((p) => p.id === grandparent.id);
    expect(grandparentRow?.rollup.subtree).toEqual(
      grandparentAfter.rollup.subtree,
    );
  });

  it("sums subtree costEstimate over non-null values, null when the subtree has none", async () => {
    const { output: parent, entityId: parentEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "estimate parent", costEstimate: 100 }),
      ctx.actor,
    );
    const { output: child, entityId: childEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "estimate child",
        parentProjectId: parent.id,
        costEstimate: 50,
      }),
      ctx.actor,
    );

    expect(
      (await getProjectByID(ctx.db, parentEntityId)).rollup.subtree
        .costEstimate,
    ).toBe(150);

    // A leaf's subtree estimate is just its own.
    const childAfter = await getProjectByID(ctx.db, childEntityId);
    expect(childAfter.rollup.subtree.costEstimate).toBe(
      childAfter.costEstimate,
    );
    expect(childAfter.rollup.subtree.costEstimate).toBe(50);

    // Parent unestimated, child estimated — the child's value still surfaces.
    await updateProject(ctx.db, parent.id, { costEstimate: null }, ctx.actor);
    expect(
      (await getProjectByID(ctx.db, parentEntityId)).rollup.subtree
        .costEstimate,
    ).toBe(50);

    // Nothing in the subtree estimated — null, not 0.
    await updateProject(ctx.db, child.id, { costEstimate: null }, ctx.actor);
    const allNull = await getProjectByID(ctx.db, parentEntityId);
    expect(allNull.rollup.subtree.costEstimate).toBeNull();
  });

  /**
   * LOAD-BEARING for the UI: `ProjectTable`'s "Actual" column and
   * `ProjectCard` both read `rollup.subtree.*` unconditionally rather than
   * branching on `subtree.projectCount > 0` / falling back to
   * `?? costEstimate`. That's only safe because a leaf's subtree IS its own
   * rollup — `aggregateSubtreeRollups` seeds the accumulator from the own
   * rollup and the own estimate, so with no children there is nothing to add.
   * If this test ever fails, restore those branches before touching anything
   * else.
   */
  it("a leaf's subtree rollup and subtree estimate degenerate to its own (the UI's no-branch invariant)", async () => {
    const { output: leaf, entityId: leafEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "invariant leaf", costEstimate: 42 }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "invariant actual",
        projectId: leaf.id,
        cost: 30,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "invariant committed",
        projectId: leaf.id,
        cost: 12,
        future: true,
      }),
      ctx.actor,
    );

    const assertLeafInvariant = (row: {
      costEstimate: number | null;
      rollup: (typeof leaf)["rollup"];
    }) => {
      const { subtree, ...own } = row.rollup;
      expect(subtree.projectCount).toBe(0);
      expect(subtree).toEqual({ ...own, projectCount: 0, costEstimate: 42 });
      // The two dead fallbacks, spelled out: neither branch can ever differ.
      expect(subtree.actualSpent).toBe(own.actualSpent);
      expect(subtree.costEstimate ?? row.costEstimate).toBe(
        subtree.costEstimate,
      );
    };

    // Both read paths the UI uses: the single-project reader and the list.
    assertLeafInvariant(await getProjectByID(ctx.db, leafEntityId));
    const { data } = await projectList(ctx.db, {}, [], {
      pageIndex: 0,
      pageSize: 10,
    });
    const listed = data.find((p) => p.id === leaf.id);
    expect(listed).toBeDefined();
    if (listed) assertLeafInvariant(listed);

    // ...and the dashboard summary, which is what ProjectCard renders.
    const summary = await projectDashboardSummary(ctx.db, {});
    const carded = summary.projects.find((p) => p.id === leaf.id);
    expect(carded).toBeDefined();
    if (carded) assertLeafInvariant(carded);
  });

  it("filters the list by topLevelOnly and parentProjectId", async () => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "filter parent" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "filter child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );

    const topLevel = await projectList(ctx.db, { topLevelOnly: true }, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    expect(topLevel.data.map((p) => p.id)).toContain(parent.id);
    expect(topLevel.data.map((p) => p.id)).not.toContain(child.id);

    const childrenOfParent = await projectList(
      ctx.db,
      { parentProjectId: parent.id },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(childrenOfParent.data.map((p) => p.id)).toEqual([child.id]);
  });

  it("filters by multiple statuses, kinds, and locations", async () => {
    const { output: first } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "multi first",
        status: "planning",
        kind: "furniture",
        locations: ["Garage"],
      }),
      ctx.actor,
    );
    const { output: second } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "multi second",
        status: "done",
        kind: "garden",
        locations: ["Yard"],
      }),
      ctx.actor,
    );
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "multi excluded",
        status: "in_progress",
        kind: "workshop",
        locations: ["Kitchen"],
      }),
      ctx.actor,
    );

    const result = await projectList(
      ctx.db,
      {
        status: ["planning", "done"],
        kind: ["furniture", "garden"],
        location: ["Garage", "Yard"],
      },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(result.data.map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(result.count).toBe(2);
  });

  it("supports explicit parent presence and includes each child as a row", async () => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "presence parent" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "presence child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );

    const roots = await projectList(
      ctx.db,
      { parentProjectPresenceFilter: "none" },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(roots.data.map((row) => row.id)).toEqual([parent.id]);

    const nested = await projectList(
      ctx.db,
      { parentProjectPresenceFilter: "has" },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(nested.data.map((row) => row.id)).toEqual([child.id]);
    expect(nested.data[0]?.parentProjectName).toBe(parent.name);
  });

  it("filters completion year by effective end with updatedAt fallback", async () => {
    const { output: dated } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "completed by effective end",
        endDate: "2024-09-10",
      }),
      ctx.actor,
    );
    const { output: fallback, entityId: fallbackEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "completed by update fallback" }),
        ctx.actor,
      );
    await getDb(ctx.db)
      .update(project)
      .set({ updatedAt: new Date("2022-04-05T12:00:00Z") })
      .where(eq(project.id, fallbackEntityId));

    const byEnd = await projectList(ctx.db, { completionYear: "2024" }, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    expect(byEnd.data.map((row) => row.id)).toEqual([dated.id]);

    const byFallback = await projectList(
      ctx.db,
      { completionYear: "2022" },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(byFallback.data.map((row) => row.id)).toEqual([fallback.id]);
  });

  it("embedded task and expense lists require a matching live project", async () => {
    const { output: matching } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "embedded matching",
        kind: "household",
      }),
      ctx.actor,
    );
    const { output: other } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "embedded other", kind: "garden" }),
      ctx.actor,
    );
    const { output: matchingTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "matching attached task",
        trade: "other",
        projectId: matching.id,
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "other attached task",
        trade: "other",
        projectId: other.id,
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "unassigned task",
        trade: "other",
      }),
      ctx.actor,
    );
    const { output: matchingExpense } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "matching attached expense",
        date: "2024-01-10",
        trade: "other",
        costType: "materials",
        projectId: matching.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "other attached expense",
        date: "2024-01-10",
        trade: "other",
        costType: "materials",
        projectId: other.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "unassigned expense",
        date: "2024-01-10",
        trade: "other",
        costType: "materials",
      }),
      ctx.actor,
    );

    const tasks = await taskList(
      ctx.db,
      { projectScope: { kinds: ["household"] } },
      [],
      { pageIndex: 0, pageSize: 1 },
    );
    expect(tasks.data.map((row) => row.id)).toEqual([matchingTask.id]);
    expect(tasks.count).toBe(1);

    const expenses = await expenseList(
      ctx.db,
      { projectScope: { kinds: ["household"] } },
      [],
      { pageIndex: 0, pageSize: 1 },
    );
    expect(expenses.data.map((row) => row.id)).toEqual([matchingExpense.id]);
    expect(expenses.count).toBe(1);
  });

  it("includeSubProjects expands the expense filter to the whole subtree", async () => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "subtree filter parent" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "subtree filter child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );
    const { output: grandchild } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "subtree filter grandchild",
        parentProjectId: child.id,
      }),
      ctx.actor,
    );

    for (const [project, name] of [
      [parent, "parent expense"],
      [child, "child expense"],
      [grandchild, "grandchild expense"],
    ] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "materials",
          name,
          projectId: project.id,
          cost: 10,
        }),
        ctx.actor,
      );
    }

    const pagination = { pageIndex: 0, pageSize: 50 };

    // Direct-only (flag unset): just the parent's own expense.
    const directOnly = await expenseList(
      ctx.db,
      { projectId: parent.id },
      [],
      pagination,
    );
    expect(directOnly.count).toBe(1);
    expect(directOnly.data.map((p) => p.name)).toEqual(["parent expense"]);

    // Subtree: parent + child + grandchild.
    const subtree = await expenseList(
      ctx.db,
      { projectId: parent.id, includeSubProjects: true },
      [],
      pagination,
    );
    expect(subtree.count).toBe(3);
    expect(new Set(subtree.data.map((p) => p.name))).toEqual(
      new Set(["parent expense", "child expense", "grandchild expense"]),
    );
  });
});

// P0 regression guard: `parentProjectId` that was SUPPLIED but resolved to no
// live project must not fall through to "no constraint" (which would return
// every project in the table) — this file already asserts that shape via
// `sql\`false\`` when `parentCodes.length > 0 && parentProjectUuids.length ===
// 0`; what regressed was `resolveShortcodes`' canonical-key lookup: it keys its
// result Map by the CANONICAL code, and the inlined resolver here indexed it by
// the RAW input code, so a lowercase or legacy-prefix code resolved fine in SQL
// but missed the Map and silently fell into the "unresolved" (zero-row) branch.
describe("project repository — parentProjectId filter widening & canonicalization guard", () => {
  const ctx = withTestDb();
  const pagination = { pageIndex: 0, pageSize: 50 };

  it("an unresolvable parentProjectId matches nothing, not every project", async () => {
    await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "widening guard project one" }),
      ctx.actor,
    );
    await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "widening guard project two" }),
      ctx.actor,
    );

    const bogus = unsafeProjectShortcode("PRJ-9999");
    const { data, count } = await projectList(
      ctx.db,
      { parentProjectId: bogus },
      [],
      pagination,
    );
    expect(data).toEqual([]);
    expect(count).toBe(0);
  });

  it("a lowercase parentProjectId still resolves and filters correctly", async () => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "widening guard lowercase parent" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "widening guard lowercase child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "widening guard lowercase unrelated project",
      }),
      ctx.actor,
    );

    const lowercase = unsafeProjectShortcode(parent.id.toLowerCase());
    const { data } = await projectList(
      ctx.db,
      { parentProjectId: lowercase },
      [],
      pagination,
    );
    expect(data.map((row) => row.id)).toEqual([child.id]);
  });
});

/**
 * The WBS renderer's page reader. What's being pinned throughout: the tree page
 * selects the SAME projects the flat list would, and differs only in what a
 * "page" is — roots of the filtered forest, each carrying its matching
 * descendants. Every assertion here is about that boundary, because the whole
 * point of the endpoint is that the browser never gets to decide it.
 */
describe("project repository — WBS tree page", () => {
  const ctx = withTestDb();

  /** `parent → child → grandchild`, plus a standalone project. */
  const makeChain = async (prefix: string) => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: `${prefix} parent` }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: `${prefix} child`,
        parentProjectId: parent.id,
        status: "done",
      }),
      ctx.actor,
    );
    const { output: grandchild } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: `${prefix} grandchild`,
        parentProjectId: child.id,
      }),
      ctx.actor,
    );
    return { parent, child, grandchild };
  };

  const page = (pageIndex: number, pageSize: number) => ({
    pageIndex,
    pageSize,
  });

  it("counts ROOTS, not rows, and returns each root's whole matching subtree", async () => {
    const { parent, child, grandchild } = await makeChain("tree");
    const { output: standalone } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "tree standalone" }),
      ctx.actor,
    );

    const result = await projectTreePage(ctx.db, {}, [], page(0, 50));

    // Four projects, two roots — the count is the paging unit, which is what
    // the infinite-scroll page arithmetic compares against.
    expect(result.count).toBe(2);
    expect(new Set(result.data.map((row) => row.id))).toEqual(
      new Set([parent.id, child.id, grandchild.id, standalone.id]),
    );
  });

  it("paginates by root, carrying descendants along with their root", async () => {
    const { parent, child, grandchild } = await makeChain("paged");
    const { output: standalone } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "paged standalone" }),
      ctx.actor,
    );

    const sortByName = [
      { orderBy: "name" as const, direction: "asc" as const },
    ];
    const first = await projectTreePage(ctx.db, {}, sortByName, page(0, 1));
    const second = await projectTreePage(ctx.db, {}, sortByName, page(1, 1));

    // Page 1 is one root plus its two descendants — a page of ONE root is
    // three rows, which is exactly the thing a row-paginated list can't do.
    expect(first.count).toBe(2);
    expect(new Set(first.data.map((row) => row.id))).toEqual(
      new Set([parent.id, child.id, grandchild.id]),
    );
    expect(second.data.map((row) => row.id)).toEqual([standalone.id]);
  });

  it("promotes a matching project whose parent does not match to a root", async () => {
    const { parent, child, grandchild } = await makeChain("promote");

    // Only the `done` child matches. Its parent is excluded, so it must become
    // a root of its own rather than disappearing under an unmatched parent —
    // the same orphan promotion the client builder does, decided here.
    const result = await projectTreePage(
      ctx.db,
      { status: ["done"] },
      [],
      page(0, 50),
    );

    expect(result.count).toBe(1);
    expect(result.data.map((row) => row.id)).toEqual([child.id]);
    expect(result.data.map((row) => row.id)).not.toContain(parent.id);
    expect(result.data.map((row) => row.id)).not.toContain(grandchild.id);
  });

  it("excludes a page root's descendants that don't match the filter", async () => {
    const { parent, child, grandchild } = await makeChain("narrow");

    // The chain's middle link is `done`; filtering it out must not drag it in
    // as part of its root's closure.
    const result = await projectTreePage(
      ctx.db,
      { status: [...LIVE_PROJECT_STATUSES] },
      [],
      page(0, 50),
    );

    const ids = result.data.map((row) => row.id);
    expect(ids).toContain(parent.id);
    expect(ids).toContain(grandchild.id);
    expect(ids).not.toContain(child.id);
    // The grandchild's own parent is gone from the result, so it is a root
    // too: two roots, not one.
    expect(result.count).toBe(2);
  });

  it("selects the same set as the flat list, differing only in paging unit", async () => {
    await makeChain("parity");
    const filters = { search: "parity" };

    const flat = await projectList(ctx.db, filters, [], page(0, 500));
    const tree = await projectTreePage(ctx.db, filters, [], page(0, 500));

    expect(new Set(tree.data.map((row) => row.id))).toEqual(
      new Set(flat.data.map((row) => row.id)),
    );
    expect(flat.count).toBe(3);
    expect(tree.count).toBe(1);
  });

  it("omits soft-deleted projects as roots and as descendants", async () => {
    const { parent, child, grandchild } = await makeChain("deleted");
    const { output: standalone } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "deleted standalone" }),
      ctx.actor,
    );
    // Bottom-up: `deleteProjects` refuses a project that still has children
    // (PROJECT_HAS_CHILDREN), so a dangling middle link isn't a state the app
    // can reach — the leaf is the real case.
    await deleteProjects(ctx.db, [grandchild.id, standalone.id], ctx.actor);

    const result = await projectTreePage(ctx.db, {}, [], page(0, 50));

    const ids = result.data.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([parent.id, child.id]));
    expect(ids).not.toContain(grandchild.id);
    // ...and a deleted ROOT doesn't just vanish from the rows, it stops
    // counting toward the page total.
    expect(ids).not.toContain(standalone.id);
    expect(result.count).toBe(1);
  });

  it("returns rows in the query's global sort order, so siblings nest sorted", async () => {
    const { output: root } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "order root" }),
      ctx.actor,
    );
    for (const name of ["order zeta", "order alpha", "order mid"]) {
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name, parentProjectId: root.id }),
        ctx.actor,
      );
    }

    const result = await projectTreePage(
      ctx.db,
      { search: "order" },
      [{ orderBy: "name", direction: "asc" }],
      page(0, 50),
    );

    // The client nests by preserving input order within each sibling group,
    // so this ordering IS the rendered per-level ordering.
    expect(result.data.map((row) => row.name)).toEqual([
      "order alpha",
      "order mid",
      "order root",
      "order zeta",
    ]);
  });

  it("returns an empty page (with the real root count) past the last root", async () => {
    await makeChain("beyond");

    const result = await projectTreePage(ctx.db, {}, [], page(5, 10));

    expect(result.data).toEqual([]);
    expect(result.count).toBe(1);
  });
});

describe("project repository — date windows (derivation)", () => {
  const ctx = withTestDb();

  it("derives dates purely from own content when no override is set", async () => {
    const { output: project, entityId: projectEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "dates content only" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "dates content task",
        projectId: project.id,
        dueDate: "2024-02-01",
        dueEndDate: "2024-02-03",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "dates content expense",
        projectId: project.id,
        cost: 10,
        date: "2024-01-15",
      }),
      ctx.actor,
    );

    const after = await getProjectByID(ctx.db, projectEntityId);
    expect(after.dates).toEqual({
      derivedStart: "2024-01-15",
      derivedEnd: "2024-02-03",
      effectiveStart: "2024-01-15",
      effectiveEnd: "2024-02-03",
      startSource: "derived",
      endSource: "derived",
    });
  });

  it("resolves start and end independently: an explicit start overrides while a null end still derives", async () => {
    const { output: project, entityId: projectEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "dates per-side override",
        startDate: "2024-01-01",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "per-side task",
        projectId: project.id,
        dueDate: "2024-03-01",
      }),
      ctx.actor,
    );

    const after = await getProjectByID(ctx.db, projectEntityId);
    expect(after.dates.startSource).toBe("explicit");
    expect(after.dates.effectiveStart).toBe("2024-01-01");
    expect(after.dates.endSource).toBe("derived");
    expect(after.dates.effectiveEnd).toBe("2024-03-01");
  });

  it("propagates a child's OVERRIDE into the parent's derived window, not the child's raw content dates", async () => {
    const { output: parent, entityId: parentEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "dates parent propagation" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "dates child propagation",
        parentProjectId: parent.id,
        // A deliberate forward override, wider than the child's own dated
        // work below — the parent should see THIS, not the narrower raw date.
        endDate: "2025-12-31",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "child narrow task",
        projectId: child.id,
        dueDate: "2024-01-05",
      }),
      ctx.actor,
    );

    const parentAfter = await getProjectByID(ctx.db, parentEntityId);
    expect(parentAfter.dates.derivedEnd).toBe("2025-12-31");
    expect(parentAfter.dates.endSource).toBe("derived");
  });

  it("returns an all-null date window with 'none' sources for a project with no content and no override", async () => {
    const { entityId: projectEntityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "dates empty" }),
      ctx.actor,
    );
    const after = await getProjectByID(ctx.db, projectEntityId);
    expect(after.dates).toEqual({
      derivedStart: null,
      derivedEnd: null,
      effectiveStart: null,
      effectiveEnd: null,
      startSource: "none",
      endSource: "none",
    });
  });

  // The create/update cycle guard (crud.ts's `wouldCreateProjectCycle`) means
  // a cyclic parent chain can never actually be persisted through the repo —
  // so this exercises `aggregateSubtreeDates` directly with a hand-built
  // cyclic row pair, the same white-box approach gantt-model.unit.test.ts and
  // project-tree.unit.test.ts use for their own cycle-termination tests.
  it("does not hang on a cyclic parent chain — depth-capped at MAX_PROJECT_TREE_DEPTH", () => {
    const a: ProjectParentRow = {
      id: unsafeProjectId("cycle-a"),
      shortcode: "PRJ-4K7M",
      name: "cycle a",
      parentProjectId: unsafeProjectId("cycle-b"),
      costEstimate: null,
      startDate: null,
      endDate: null,
      status: "in_progress",
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    };
    const b: ProjectParentRow = {
      id: unsafeProjectId("cycle-b"),
      shortcode: "PRJ-5N8Q",
      name: "cycle b",
      parentProjectId: unsafeProjectId("cycle-a"),
      costEstimate: null,
      startDate: null,
      endDate: null,
      status: "in_progress",
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    };
    const ownDates = new Map([
      [a.id, { contentStart: "2024-01-05", contentEnd: "2024-01-05" }],
      [b.id, EMPTY_PROJECT_CONTENT_DATES],
    ]);

    const result = aggregateSubtreeDates([a, b], ownDates);

    // The depth cap still lets the fold see all the way around the 2-cycle
    // (well under 100 hops), so both nodes converge on the same union of
    // reachable content — min/max folding is idempotent, so the eventual
    // truncation at the cap doesn't lose either side's real date.
    const expected = {
      derivedStart: "2024-01-05",
      derivedEnd: "2024-01-05",
      effectiveStart: "2024-01-05",
      effectiveEnd: "2024-01-05",
      startSource: "derived",
      endSource: "derived",
    };
    expect(result.get(a.id)).toEqual(expected);
    expect(result.get(b.id)).toEqual(expected);
  });

  /**
   * Regression: the `startDate` sort resolver is a correlated sub-select fed
   * to `query.project.findMany`, whose alias mapper rewrites every column ref
   * inside the clause to the root alias — a `sql` template over Drizzle column
   * refs emitted `min("project"."dueDate") from "Task"` and threw at runtime.
   * It shipped broken because nothing exercised this sort, and `startDate` is
   * the projects table's DEFAULT sort. It must also sort by the EARLIER of the
   * task and expense mins (LEAST, not a coalesce chain) so the ordering
   * agrees with the `dates.effectiveStart` each row displays.
   */
  it("sorts by effective start, folding override and both content sources", async () => {
    // Override far in the past — must sort first ascending even though its
    // own content is much later.
    const { output: overridden } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "sort override early",
        startDate: "2001-01-01",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "sort override task",
        projectId: overridden.id,
        dueDate: "2024-09-01",
      }),
      ctx.actor,
    );

    // No override, and its EXPENSE predates its task — the coalesce-chain bug
    // sorted this by the task min (2024-08-01) instead of 2024-03-01.
    const { output: derived } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "sort derived middle" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "sort derived task",
        projectId: derived.id,
        dueDate: "2024-08-01",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "sort derived expense",
        projectId: derived.id,
        cost: 5,
        date: "2024-03-01",
      }),
      ctx.actor,
    );

    // Neither override nor content — sorts last in BOTH directions (the
    // house-wide nulls-last convention).
    const { output: undated } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "sort undated" }),
      ctx.actor,
    );

    const page = { pageIndex: 0, pageSize: 100 };
    const asc = await projectList(
      ctx.db,
      {},
      [{ orderBy: "startDate", direction: "asc" }],
      page,
    );
    const desc = await projectList(
      ctx.db,
      {},
      [{ orderBy: "startDate", direction: "desc" }],
      page,
    );

    const positions = (rows: { id: string }[]) => ({
      overridden: rows.findIndex((r) => r.id === overridden.id),
      derived: rows.findIndex((r) => r.id === derived.id),
      undated: rows.findIndex((r) => r.id === undated.id),
    });

    const ascPos = positions(asc.data);
    expect(ascPos.overridden).toBeLessThan(ascPos.derived);
    expect(ascPos.derived).toBeLessThan(ascPos.undated);

    const descPos = positions(desc.data);
    expect(descPos.derived).toBeLessThan(descPos.overridden);
    expect(descPos.overridden).toBeLessThan(descPos.undated);

    // The sort key and the displayed window agree: the derived row's start is
    // the expense date, not the later task date.
    expect(
      asc.data.find((r) => r.id === derived.id)?.dates.effectiveStart,
    ).toBe("2024-03-01");
  });
});

describe("project dashboard — attention detector + summary", () => {
  const ctx = withTestDb();

  it("flags missing_budget only for a project with spend and no estimate", async () => {
    const { output: noEstimate } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "attention no estimate" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "spend with no estimate",
        projectId: noEstimate.id,
        cost: 75,
        future: false,
      }),
      ctx.actor,
    );

    const { output: withEstimate } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "attention with estimate",
        costEstimate: 500,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        date: "2024-01-15",
        trade: "other",
        costType: "materials",
        name: "spend with estimate",
        projectId: withEstimate.id,
        cost: 75,
        future: false,
      }),
      ctx.actor,
    );

    const items = await computeAttentionItems(ctx.db);
    const missingBudgetIds = items
      .filter((i) => i.type === "missing_budget")
      .map((i) => i.entityId);
    expect(missingBudgetIds).toContain(noEstimate.id);
    expect(missingBudgetIds).not.toContain(withEstimate.id);
  });

  it("flags blocked_work for an in_progress project whose only task is blocked (no next task)", async () => {
    const { output: blockedProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "attention blocked project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const { output: blockedTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "attention blocked task",
        projectId: blockedProject.id,
      }),
      ctx.actor,
    );
    await updateTask(ctx.db, blockedTask.id, { status: "blocked" }, ctx.actor);

    // Control: an in_progress project with an open (unblocked) task must NOT
    // be flagged — it has a `next` task available.
    const { output: unblockedProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "attention unblocked project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "attention open task",
        projectId: unblockedProject.id,
      }),
      ctx.actor,
    );

    const items = await computeAttentionItems(ctx.db);
    const blockedWorkIds = items
      .filter((i) => i.type === "blocked_work")
      .map((i) => i.entityId);
    expect(blockedWorkIds).toContain(blockedProject.id);
    expect(blockedWorkIds).not.toContain(unblockedProject.id);
  });

  it("scopes dashboard attention to matched projects while retaining unassigned work", async () => {
    const { output: includedProject, entityId: includedProjectEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "attention included" }),
        ctx.actor,
      );
    const { output: excludedProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "attention excluded" }),
      ctx.actor,
    );
    const { output: included } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "included overdue",
        projectId: includedProject.id,
        dueDate: "2020-01-01",
      }),
      ctx.actor,
    );
    const { output: excluded } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "excluded overdue",
        projectId: excludedProject.id,
        dueDate: "2020-01-01",
      }),
      ctx.actor,
    );
    const { output: unassigned } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "unassigned overdue",
        dueDate: "2020-01-01",
      }),
      ctx.actor,
    );

    const scoped = await computeAttentionItems(ctx.db, {
      projectIds: [includedProjectEntityId],
    });
    const overdueIds = scoped
      .filter((item) => item.type === "overdue_task")
      .map((item) => item.entityId);

    expect(overdueIds).toContain(included.id);
    expect(overdueIds).toContain(unassigned.id);
    expect(overdueIds).not.toContain(excluded.id);
  });

  it("flags date_window_drift on both a too-late start and a too-early end", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "attention drift both",
        startDate: "2024-06-01", // after the earliest dated work below
        endDate: "2024-06-10", // before the latest dated work below
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "drift early task",
        projectId: project.id,
        dueDate: "2024-01-01",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "drift late expense",
        projectId: project.id,
        cost: 10,
        date: "2024-12-31",
      }),
      ctx.actor,
    );

    const items = await computeAttentionItems(ctx.db);
    const drift = items.filter(
      (i) => i.type === "date_window_drift" && i.entityId === project.id,
    );
    expect(drift).toHaveLength(2);
    expect(drift.map((d) => d.date).sort()).toEqual([
      "2024-01-01",
      "2024-12-31",
    ]);
    expect(drift.map((d) => d.severity)).toEqual(["info", "info"]);
    expect(drift.map((d) => d.href)).toEqual([
      `/projects/${project.id}`,
      `/projects/${project.id}`,
    ]);
    const startItem = drift.find((d) => d.date === "2024-01-01");
    expect(startItem?.description).toBe(
      "Start date 2024-06-01 is after the earliest dated work (2024-01-01)",
    );
    const endItem = drift.find((d) => d.date === "2024-12-31");
    expect(endItem?.description).toBe(
      "End date 2024-06-10 is before the latest dated work (2024-12-31)",
    );

    // These two rows are the reason `key` exists: same type, same entityId, so
    // a type+entityId React key collided and the list could silently drop one.
    expect(startItem?.key).toBe(`date_window_drift:${project.id}:start`);
    expect(endItem?.key).toBe(`date_window_drift:${project.id}:end`);

    // The invariant the renderers depend on, asserted over EVERY rule — a new
    // rule that can fire twice for one entity must add its own discriminator.
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not flag date_window_drift when the override is wider than derived, or exactly equal to it", async () => {
    const { output: wider } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "attention drift wider",
        // Deliberate forward/backward intent — wider than any dated work, not
        // drift. (Mirrors the real "Wedding" project's forward endDate.)
        startDate: "2020-01-01",
        endDate: "2030-01-01",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "drift wider task",
        projectId: wider.id,
        dueDate: "2024-05-01",
      }),
      ctx.actor,
    );

    const { output: exact } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "attention drift exact",
        startDate: "2024-05-01",
        endDate: "2024-05-01",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "drift exact task",
        projectId: exact.id,
        dueDate: "2024-05-01",
      }),
      ctx.actor,
    );

    const items = await computeAttentionItems(ctx.db);
    const driftIds = items
      .filter((i) => i.type === "date_window_drift")
      .map((i) => i.entityId);
    expect(driftIds).not.toContain(wider.id);
    expect(driftIds).not.toContain(exact.id);
  });

  it("an omitted statusScope includes `done` projects in the list and in actualSpend/committedSpend", async () => {
    const { output: projectA, entityId: projectAEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({
          name: "summary spend a",
          status: "in_progress",
        }),
        ctx.actor,
      );
    const { output: projectB, entityId: projectBEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({
          name: "summary spend b",
          status: "planning",
        }),
        ctx.actor,
      );
    const { output: projectDone, entityId: projectDoneEntityId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({
          name: "summary spend done",
          status: "done",
        }),
        ctx.actor,
      );
    for (const [project, name, cost, future] of [
      [projectA, "summary a actual", 120, false],
      [projectA, "summary a committed", 30, true],
      [projectB, "summary b actual", 40, false],
      [projectDone, "summary done actual", 90, false],
      [projectDone, "summary done committed", 10, true],
    ] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "materials",
          name,
          projectId: project.id,
          cost,
          future,
        }),
        ctx.actor,
      );
    }

    const [aAfter, bAfter, doneAfter] = await Promise.all([
      getProjectByID(ctx.db, projectAEntityId),
      getProjectByID(ctx.db, projectBEntityId),
      getProjectByID(ctx.db, projectDoneEntityId),
    ]);
    const liveActual =
      aAfter.rollup.subtree.actualSpent + bAfter.rollup.subtree.actualSpent;
    const liveCommitted =
      aAfter.rollup.subtree.committedSpent +
      bAfter.rollup.subtree.committedSpent;

    // No statusScope = NO status condition: `done` is in scope like any other
    // status. (This used to silently fall back to `!= 'done'` — an invisible
    // filter nothing in the UI described.)
    const summary = await projectDashboardSummary(ctx.db, {});
    expect(summary.projects.map((p) => p.name)).toEqual([
      "summary spend a",
      "summary spend b",
      "summary spend done",
    ]);
    expect(summary.summary.actualSpend).toBe(
      liveActual + doneAfter.rollup.subtree.actualSpent,
    );
    expect(summary.summary.committedSpend).toBe(
      liveCommitted + doneAfter.rollup.subtree.committedSpent,
    );
    // The two portfolio headline stats keep a FIXED status regardless of the
    // (here absent) statusScope.
    expect(summary.summary.activeProjectCount).toBe(2);
    expect(summary.completedCount).toBe(1);

    // Excluding `done` is now something a caller opts into explicitly.
    const live = await projectDashboardSummary(ctx.db, {
      statusScope: [...LIVE_PROJECT_STATUSES],
    });
    expect(live.projects.map((p) => p.name)).toEqual([
      "summary spend a",
      "summary spend b",
    ]);
    expect(live.summary.actualSpend).toBe(liveActual);
    expect(live.summary.committedSpend).toBe(liveCommitted);
  });
});

describe("project dashboard — summary scope filters", () => {
  const ctx = withTestDb();

  /** Every fixture here is a bare project; only the scoped columns vary. */
  const mkProject = async (
    input: Partial<ProjectCreateInput> & { name: string },
  ) => {
    const { output } = await createProject(
      ctx.db,
      projectCreateInput.parse(input),
      ctx.actor,
    );
    return output;
  };

  /** Names of the projects the summary's scoped set actually returned. */
  const scopedNames = (summary: { projects: Array<{ name: string }> }) =>
    summary.projects.map((p) => p.name);

  it("statusScope selects exactly the listed statuses; omitted means all four", async () => {
    await mkProject({ name: "status planning", status: "planning" });
    await mkProject({ name: "status not started", status: "not_started" });
    await mkProject({ name: "status in progress", status: "in_progress" });
    await mkProject({ name: "status done", status: "done" });

    expect(scopedNames(await projectDashboardSummary(ctx.db, {}))).toEqual([
      "status done",
      "status in progress",
      "status not started",
      "status planning",
    ]);

    const live = await projectDashboardSummary(ctx.db, {
      statusScope: [...LIVE_PROJECT_STATUSES],
    });
    expect(scopedNames(live)).toEqual([
      "status in progress",
      "status not started",
      "status planning",
    ]);

    const doneOnly = await projectDashboardSummary(ctx.db, {
      statusScope: ["done"],
    });
    expect(scopedNames(doneOnly)).toEqual(["status done"]);
  });

  it("a ONE-element locations filter matches by array overlap (the row-constructor regression)", async () => {
    await mkProject({ name: "loc both", locations: ["Cabin", "Lake House"] });
    await mkProject({ name: "loc cabin", locations: ["Cabin"] });
    await mkProject({ name: "loc lake", locations: ["Lake House"] });

    // `sql`${col} && ${["Cabin"]}`` interpolated a ROW CONSTRUCTOR (`($1)`)
    // rather than a text[], so this returned nothing at all.
    const summary = await projectDashboardSummary(ctx.db, {
      locations: ["Cabin"],
    });
    expect(scopedNames(summary)).toEqual(["loc both", "loc cabin"]);
  });

  it("a multi-element locations filter is ANY-of, and an empty locations[] project never matches one", async () => {
    await mkProject({ name: "loc both", locations: ["Cabin", "Lake House"] });
    await mkProject({ name: "loc cabin", locations: ["Cabin"] });
    await mkProject({ name: "loc empty", locations: [] });
    await mkProject({ name: "loc lake", locations: ["Lake House"] });

    const bothKnown = await projectDashboardSummary(ctx.db, {
      locations: ["Cabin", "Lake House"],
    });
    expect(scopedNames(bothKnown)).toEqual([
      "loc both",
      "loc cabin",
      "loc lake",
    ]);

    // One known + one that exists nowhere: still ANY-of, not all-of.
    const oneUnknown = await projectDashboardSummary(ctx.db, {
      locations: ["Barn", "Lake House"],
    });
    expect(scopedNames(oneUnknown)).toEqual(["loc both", "loc lake"]);

    const noMatch = await projectDashboardSummary(ctx.db, {
      locations: ["Barn"],
    });
    expect(scopedNames(noMatch)).toEqual([]);

    // Unfiltered, the empty-locations project is in scope like any other.
    expect(scopedNames(await projectDashboardSummary(ctx.db, {}))).toEqual([
      "loc both",
      "loc cabin",
      "loc empty",
      "loc lake",
    ]);
  });

  it("the kinds filter selects exactly the listed kinds; omitted keeps kind-less projects", async () => {
    await mkProject({ name: "kind garden", kind: "garden" });
    await mkProject({ name: "kind none", kind: null });
    await mkProject({ name: "kind reno", kind: "renovation" });

    const reno = await projectDashboardSummary(ctx.db, {
      kinds: ["renovation"],
    });
    expect(scopedNames(reno)).toEqual(["kind reno"]);

    const two = await projectDashboardSummary(ctx.db, {
      kinds: ["renovation", "garden"],
    });
    expect(scopedNames(two)).toEqual(["kind garden", "kind reno"]);

    expect(scopedNames(await projectDashboardSummary(ctx.db, {}))).toEqual([
      "kind garden",
      "kind none",
      "kind reno",
    ]);
  });

  /**
   * The four interval shapes a project's `[startDate, endDate]` can take, plus
   * a fully-past control. Shared by the two date-window tests below.
   */
  const seedDateShapes = async () => {
    await mkProject({
      name: "date bounded",
      startDate: "2025-03-01",
      endDate: "2025-04-01",
    });
    await mkProject({
      name: "date early",
      startDate: null,
      endDate: "2025-02-01",
    });
    await mkProject({
      name: "date late",
      startDate: "2025-06-01",
      endDate: null,
    });
    await mkProject({ name: "date none", startDate: null, endDate: null });
    await mkProject({
      name: "date old",
      startDate: "2023-01-01",
      endDate: "2023-06-01",
    });
  };

  it("a two-sided date window keeps overlapping intervals and drops the undated project", async () => {
    await seedDateShapes();

    // No window: every shape is in scope, `date none` included.
    expect(scopedNames(await projectDashboardSummary(ctx.db, {}))).toEqual([
      "date bounded",
      "date early",
      "date late",
      "date none",
      "date old",
    ]);

    const windowed = await projectDashboardSummary(ctx.db, {
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
    });
    // `date old` ends before the window; `date none` has no interval at all
    // (without the `start IS NOT NULL OR end IS NOT NULL` conjunct it would
    // pass the other two vacuously and match every window ever chosen).
    expect(scopedNames(windowed)).toEqual([
      "date bounded",
      "date early",
      "date late",
    ]);
    expect(windowed.hiddenByDate.projects).toBe(1);
  });

  it("one-sided date windows drop only their own half, and still drop the undated project", async () => {
    await seedDateShapes();

    // dateFrom only: keeps anything still running on/after it — an open end
    // (null) counts as still running.
    const fromOnly = await projectDashboardSummary(ctx.db, {
      dateFrom: "2025-05-01",
    });
    expect(scopedNames(fromOnly)).toEqual(["date late"]);
    expect(fromOnly.hiddenByDate.projects).toBe(1);

    // dateTo only: keeps anything that had started by then — an open start
    // (null) counts as always-having-started.
    const toOnly = await projectDashboardSummary(ctx.db, {
      dateTo: "2024-12-31",
    });
    expect(scopedNames(toOnly)).toEqual(["date early", "date old"]);
    expect(toOnly.hiddenByDate.projects).toBe(1);
  });

  it("hiddenByDate only counts missing dates, so required Expense dates never contribute", async () => {
    const scoped = await mkProject({
      name: "hidden scoped",
      kind: "renovation",
      startDate: "2025-03-01",
      endDate: "2025-04-01",
    });
    const otherKind = await mkProject({
      name: "hidden other kind",
      kind: "garden",
      startDate: "2025-03-01",
      endDate: "2025-04-01",
    });
    await mkProject({
      name: "hidden undated",
      kind: "renovation",
      startDate: null,
      endDate: null,
    });

    for (const [name, projectId, dueDate] of [
      ["hidden scoped task", scoped.id, null],
      ["hidden inbox task", null, null],
      ["hidden other kind task", otherKind.id, null],
      ["hidden dated task", scoped.id, "2025-03-15"],
    ] as const) {
      await createTask(
        ctx.db,
        taskCreateInput.parse({ trade: "other", name, projectId, dueDate }),
        ctx.actor,
      );
    }

    for (const [name, projectId, date] of [
      ["hidden scoped expense", scoped.id, "2024-12-31"],
      ["hidden inbox expense", null, "2024-12-31"],
      ["hidden other kind expense", otherKind.id, "2024-12-31"],
      ["hidden dated expense", scoped.id, "2025-03-15"],
    ] as const) {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          trade: "other",
          costType: "materials",
          name,
          projectId,
          date,
        }),
        ctx.actor,
      );
    }

    const summary = await projectDashboardSummary(ctx.db, {
      kinds: ["renovation"],
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
    });
    expect(scopedNames(summary)).toEqual(["hidden scoped"]);
    // Projects and Tasks can still be undated. Expense dates are required, so
    // an out-of-window Expense is excluded normally rather than counted here.
    expect(summary.hiddenByDate).toEqual({
      projects: 1,
      tasks: 2,
      expenses: 0,
    });

    // Nothing is "hidden by date" when no window is set.
    const unwindowed = await projectDashboardSummary(ctx.db, {
      kinds: ["renovation"],
    });
    expect(unwindowed.hiddenByDate).toEqual({
      projects: 0,
      tasks: 0,
      expenses: 0,
    });
  });

  it("filterOptions.years unions expense/task/project dates, newest first, using a task's EFFECTIVE due date", async () => {
    await mkProject({
      name: "years project",
      startDate: "2020-02-01",
      endDate: "2022-03-01",
    });
    await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "years expense",
        date: "2021-05-01",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "years task",
        dueDate: "2019-01-01",
        dueEndDate: "2023-06-01",
      }),
      ctx.actor,
    );

    const summary = await projectDashboardSummary(ctx.db, {});
    // 2023 (task dueEndDate) > 2022 (project end) > 2021 (expense) > 2020
    // (project start); 2019 is absent because `dueEndDate` supersedes
    // `dueDate` — the same effective-due expression task/lookup.ts filters on.
    expect(summary.filterOptions.years).toEqual([
      "2023",
      "2022",
      "2021",
      "2020",
    ]);
    expect(summary.filterOptions.years).not.toContain("2019");
  });
});

/**
 * `projectPortfolioAnalytics` backs both the Analytics tab's charts and the
 * MCP `get_project_budget` tool, and the only coverage it had was a mocked
 * unit test (`mcp/server.unit.test.ts`). These pin the two aggregates whose
 * numbers come out of the subtree rollup — `costVsEstimate` and
 * `spendingByProject` — against a parent/child pair with spend on BOTH, plus
 * the deliberate asymmetry with the expense-grouped aggregates (which are
 * scoped to a project's OWN expenses, never subtree-expanded).
 */
describe("project dashboard — portfolio analytics", () => {
  const ctx = withTestDb();

  const mkProject = async (
    input: Partial<ProjectCreateInput> & { name: string },
  ) => {
    const { output } = await createProject(
      ctx.db,
      projectCreateInput.parse(input),
      ctx.actor,
    );
    return output;
  };

  const mkExpense = (
    name: string,
    projectId: string | null,
    cost: number,
    extra: {
      future?: boolean;
      date?: string;
      trade?: "other" | "plumbing";
      lineKind?: ExpenseCreateInput["lineKind"];
    } = {},
  ) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: extra.trade ?? "other",
        costType: "materials",
        lineKind: extra.lineKind,
        name,
        projectId,
        cost,
        future: extra.future ?? false,
        date: extra.date ?? "2025-03-15",
      }),
      ctx.actor,
    );

  /**
   * parent (est 100) ── child (est 50); plus an unrelated `done` project.
   *
   *   parent own: +100 actual, +25 committed
   *   child  own: +40 actual, −15 contribution
   *   solo   own: +200 actual
   */
  const seedPortfolio = async () => {
    const parent = await mkProject({
      name: "analytics parent",
      status: "in_progress",
      costEstimate: 100,
    });
    const child = await mkProject({
      name: "analytics child",
      status: "planning",
      parentProjectId: parent.id,
      costEstimate: 50,
    });
    const solo = await mkProject({
      name: "analytics solo",
      status: "done",
      costEstimate: 10,
    });

    await mkExpense("parent actual", parent.id, 100);
    await mkExpense("parent committed", parent.id, 25, { future: true });
    await mkExpense("child actual", child.id, 40, { trade: "plumbing" });
    await mkExpense("child contribution", child.id, -15);
    await mkExpense("solo actual", solo.id, 200);

    return { parent, child, solo };
  };

  it("reports subtree actual/committed/estimate per project in costVsEstimate", async () => {
    const { parent, child, solo } = await seedPortfolio();

    const analytics = await projectPortfolioAnalytics(ctx.db, {});

    // Ordered by project name (the scoped project query's `asc(project.name)`).
    expect(analytics.costVsEstimate).toEqual([
      {
        projectId: child.id,
        projectName: "analytics child",
        // A leaf: subtree == own. The −15 contribution is NOT netted out of
        // `actual` (that's `spent`'s job).
        actual: 40,
        committed: 0,
        estimate: 50,
      },
      {
        projectId: parent.id,
        projectName: "analytics parent",
        actual: 140, // 100 own + 40 child
        committed: 25, // own only — the child has none
        estimate: 150, // 100 own + 50 child
      },
      {
        projectId: solo.id,
        projectName: "analytics solo",
        actual: 200,
        committed: 0,
        estimate: 10,
      },
    ]);
  });

  it("sorts spendingByProject by subtree `spent` descending, contributions netted in", async () => {
    const { parent, child, solo } = await seedPortfolio();

    const analytics = await projectPortfolioAnalytics(ctx.db, {});

    // `spent` is the blended sum(cost): parent = 100 + 25 + (40 − 15) = 150,
    // child = 40 − 15 = 25, solo = 200.
    expect(analytics.spendingByProject).toEqual([
      {
        projectId: solo.id,
        projectName: "analytics solo",
        spend: 200,
      },
      {
        projectId: parent.id,
        projectName: "analytics parent",
        spend: 150,
      },
      {
        projectId: child.id,
        projectName: "analytics child",
        spend: 25,
      },
    ]);
  });

  it("keeps subtree totals whole while the expense-grouped aggregates stay own-only", async () => {
    const { parent } = await seedPortfolio();

    // Scope to the parent alone — its child is NOT in the filtered id set.
    const analytics = await projectPortfolioAnalytics(ctx.db, {
      search: "analytics parent",
    });

    expect(analytics.costVsEstimate).toEqual([
      {
        projectId: parent.id,
        projectName: "analytics parent",
        // Subtree aggregates are over LIVE descendants, not the filtered set:
        // the child's spend/estimate still rolls up here.
        actual: 140,
        committed: 25,
        estimate: 150,
      },
    ]);
    expect(analytics.spendingByProject).toEqual([
      {
        projectId: parent.id,
        projectName: "analytics parent",
        spend: 150,
      },
    ]);

    // ...but the expense-grouped aggregates count only expenses whose OWN
    // projectId matched, so the child's rows are absent.
    expect(analytics.tradeActivity).toEqual([
      {
        trade: "other",
        actual: 100,
        committed: 25,
        credits: 0,
        net: 125,
        count: 2,
      },
    ]);
    expect(analytics.monthlySpend).toEqual([
      {
        month: "2025-03",
        actual: 100,
        committed: 25,
        credits: 0,
        net: 125,
        count: 2,
      },
    ]);
    expect(analytics.plannedVsActual).toEqual([
      { month: "2025-03", planned: 25, actual: 100 },
    ]);
  });

  it("keeps adjustments in totals while excluding them from trade activity", async () => {
    const project = await mkProject({
      name: "analytics adjustment project",
      status: "in_progress",
    });
    await mkExpense("adjustment principal", project.id, 100);
    await mkExpense("Sales tax", project.id, 10, { lineKind: "tax" });
    await mkExpense("Order discount", project.id, -5, {
      lineKind: "discount",
    });

    const analytics = await projectPortfolioAnalytics(ctx.db, {
      search: "analytics adjustment project",
    });
    expect(analytics.spendingByProject[0]?.spend).toBe(105);
    expect(analytics.monthlySpend[0]?.net).toBe(105);
    expect(analytics.plannedVsActual[0]?.actual).toBe(105);
    expect(analytics.tradeActivity).toEqual([
      {
        trade: "other",
        actual: 100,
        committed: 0,
        credits: 0,
        net: 100,
        count: 1,
      },
    ]);
    expect(analytics.adjustments).toEqual({
      actual: 10,
      committed: 0,
      credits: 5,
      net: 5,
      count: 2,
    });
  });

  it("scopes the whole result by statusScope, and returns empty when nothing matches", async () => {
    const { solo } = await seedPortfolio();

    const doneOnly = await projectPortfolioAnalytics(ctx.db, {
      statusScope: ["done"],
    });
    expect(doneOnly.costVsEstimate.map((r) => r.projectId)).toEqual([solo.id]);
    expect(doneOnly.spendingByProject.map((r) => r.projectId)).toEqual([
      solo.id,
    ]);

    const none = await projectPortfolioAnalytics(ctx.db, {
      search: "no such project",
    });
    expect(none).toEqual({
      costVsEstimate: [],
      spendingByProject: [],
      monthlySpend: [],
      plannedVsActual: [],
      tradeActivity: [],
      adjustments: {
        actual: 0,
        committed: 0,
        credits: 0,
        net: 0,
        count: 0,
      },
      taskHeatmap: [],
    });
  });

  it("counts open top-level tasks per project in taskHeatmap (own tasks, not subtree)", async () => {
    const { parent, child, solo } = await seedPortfolio();

    for (const [name, projectId] of [
      ["heatmap parent open", parent.id],
      ["heatmap child open a", child.id],
      ["heatmap child open b", child.id],
    ] as const) {
      await createTask(
        ctx.db,
        taskCreateInput.parse({ trade: "other", name, projectId }),
        ctx.actor,
      );
    }
    const { output: doneTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "heatmap parent done",
        projectId: parent.id,
      }),
      ctx.actor,
    );
    await updateTask(ctx.db, doneTask.id, { status: "done" }, ctx.actor);

    const analytics = await projectPortfolioAnalytics(ctx.db, {});
    expect(analytics.taskHeatmap).toEqual([
      {
        projectId: child.id,
        projectName: "analytics child",
        openTaskCount: 2,
      },
      // 1, not 3 — own open tasks only, and the done one doesn't count.
      {
        projectId: parent.id,
        projectName: "analytics parent",
        openTaskCount: 1,
      },
      {
        projectId: solo.id,
        projectName: "analytics solo",
        openTaskCount: 0,
      },
    ]);
  });
});

/**
 * The `costEstimate` footer's full-filtered-set total (see
 * `createCurrencyColumn`'s footer and `repo/project/lookup.ts`'s
 * `projectListSums`). `apps/web/src/app/projects/shared.tsx`'s Estimate column
 * renders `meta.serverTotals.sums.costEstimate` when the server supplies it and
 * otherwise falls back to reducing only the LOADED page — with page size 25
 * and production sitting at 63 root projects, that fallback silently summed
 * 25 of 63 rows and presented it as the total. These tests seed MORE than one
 * page so a page-subtotal and the full-set total genuinely differ; a test with
 * fewer rows than a page would pass even with the old broken fallback.
 */
describe("project repository — sums.costEstimate", () => {
  const ctx = withTestDb();

  const page = (pageIndex: number, pageSize: number) => ({
    pageIndex,
    pageSize,
  });

  it("projectList sums the FULL filtered set, not the loaded page", async () => {
    // 7 projects, page size 3 — three full pages' worth, so any one page's
    // rows sum to well under the true total.
    const estimates = [10, 20, 30, 40, 50, 60, 70];
    for (const [i, costEstimate] of estimates.entries()) {
      await createProject(
        ctx.db,
        projectCreateInput.parse({
          name: `sum flat ${String(i).padStart(2, "0")}`,
          costEstimate,
        }),
        ctx.actor,
      );
    }
    const total = estimates.reduce((a, b) => a + b, 0); // 280

    const firstPage = await projectList(
      ctx.db,
      { search: "sum flat" },
      [{ orderBy: "name", direction: "asc" }],
      page(0, 3),
    );

    expect(firstPage.data).toHaveLength(3);
    const pageSubtotal = firstPage.data.reduce(
      (acc, p) => acc + (p.costEstimate ?? 0),
      0,
    );
    // The page-local reduction (10+20+30=60) is what the client-side fallback
    // would compute — genuinely different from the true total.
    expect(pageSubtotal).toBe(60);
    expect(pageSubtotal).not.toBe(total);
    // The server-supplied sum is the full 7-project total regardless of page.
    expect(firstPage.sums.costEstimate).toBe(total);

    const lastPage = await projectList(
      ctx.db,
      { search: "sum flat" },
      [{ orderBy: "name", direction: "asc" }],
      page(2, 3),
    );
    expect(lastPage.data).toHaveLength(1);
    expect(lastPage.sums.costEstimate).toBe(total);
  });

  it("projectList's sum is scoped by the applied filter", async () => {
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "sum filtered live",
        status: "planning",
        costEstimate: 100,
      }),
      ctx.actor,
    );
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "sum filtered done",
        status: "done",
        costEstimate: 9999,
      }),
      ctx.actor,
    );

    const result = await projectList(
      ctx.db,
      { search: "sum filtered", status: ["planning"] },
      [],
      page(0, 50),
    );

    expect(result.data).toHaveLength(1);
    // The done project's 9999 must not leak into a total scoped to "planning".
    expect(result.sums.costEstimate).toBe(100);
  });

  it("reads 0 over a filtered set with no cost estimates at all", async () => {
    await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "sum unestimated" }),
      ctx.actor,
    );

    const result = await projectList(
      ctx.db,
      { search: "sum unestimated" },
      [],
      page(0, 50),
    );
    // sum() over an all-NULL column is SQL NULL — coerced to 0, not passed through.
    expect(result.sums.costEstimate).toBe(0);
  });

  it("projectTreePage sums the full matching set across MULTIPLE root pages, not just the page's roots", async () => {
    // 5 standalone roots, page size 2 roots — so the true total spans more
    // than any one root-page.
    const estimates = [11, 22, 33, 44, 55];
    for (const [i, costEstimate] of estimates.entries()) {
      await createProject(
        ctx.db,
        projectCreateInput.parse({
          name: `sum tree ${String(i).padStart(2, "0")}`,
          costEstimate,
        }),
        ctx.actor,
      );
    }
    const total = estimates.reduce((a, b) => a + b, 0); // 165

    const firstRootPage = await projectTreePage(
      ctx.db,
      { search: "sum tree" },
      [{ orderBy: "name", direction: "asc" }],
      page(0, 2),
    );
    expect(firstRootPage.count).toBe(5); // 5 matching roots
    expect(firstRootPage.data).toHaveLength(2); // but only 2 roots' worth of rows
    const rootPageSubtotal = firstRootPage.data.reduce(
      (acc, p) => acc + (p.costEstimate ?? 0),
      0,
    );
    expect(rootPageSubtotal).toBe(11 + 22);
    expect(rootPageSubtotal).not.toBe(total);
    // The tree page reports the SAME full-set total the flat list would.
    expect(firstRootPage.sums.costEstimate).toBe(total);
  });

  it("projectTreePage's sum includes descendants' own estimates, not just roots' — it is NOT roots-only", async () => {
    // A root with its own estimate, plus a child under it with its OWN
    // separate estimate. The `costEstimate` column renders each row's own
    // value (see helpers.ts's `dbProjectToAPI` — not the subtree rollup), so
    // the honest total sums every matching row, root and descendant alike.
    const { output: root } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "sum tree root with child",
        costEstimate: 100,
      }),
      ctx.actor,
    );
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "sum tree child",
        parentProjectId: root.id,
        costEstimate: 50,
      }),
      ctx.actor,
    );

    // Page size 1 root — the returned page still carries the root's full
    // subtree (root + child), and the reported sum must cover both rows even
    // though only one ROOT is on this page.
    const result = await projectTreePage(
      ctx.db,
      { search: "sum tree" },
      [],
      page(0, 1),
    );

    expect(result.count).toBe(1); // one matching root
    expect(result.data).toHaveLength(2); // root + child
    expect(result.sums.costEstimate).toBe(150);
  });

  it("projectTreePage's sum is scoped by the applied filter, same as the flat list", async () => {
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "sum tree filtered live",
        status: "planning",
        costEstimate: 200,
      }),
      ctx.actor,
    );
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "sum tree filtered done",
        status: "done",
        costEstimate: 7777,
      }),
      ctx.actor,
    );

    const result = await projectTreePage(
      ctx.db,
      { search: "sum tree filtered", status: ["planning"] },
      [],
      page(0, 50),
    );

    expect(result.data).toHaveLength(1);
    expect(result.sums.costEstimate).toBe(200);
  });
});

describe("project repository — imagePresenceFilter", () => {
  const ctx = withTestDb();

  const page = { pageIndex: 0, pageSize: 50 };

  /** Attach a fresh image to `entityId`, returning both rows for mutation. */
  const attachImage = async (
    entityId: ProjectId,
    overrides: {
      contentType?: string;
      imageDeleted?: boolean;
      joinDeleted?: boolean;
    } = {},
  ) => {
    const img = await insertAndReturn(ctx.db, image, {
      key: `image-presence-${entityId}-${overrides.contentType ?? "png"}`,
      url: "https://example.com/image-presence.png",
      filename: "image-presence.png",
      contentType: overrides.contentType ?? "image/png",
      size: 100,
      status: "UPLOADED",
      ...(overrides.imageDeleted ? { deletedAt: new Date() } : {}),
    });
    await insertAndReturn(ctx.db, projectImage, {
      projectId: entityId,
      imageId: img.id,
      ...(overrides.joinDeleted ? { deletedAt: new Date() } : {}),
    });
  };

  it("partitions projects with a displayable image from those without", async () => {
    const { output: withImage, entityId: withImageId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "presence with image" }),
      ctx.actor,
    );
    const { output: withoutImage } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "presence without image" }),
      ctx.actor,
    );
    await attachImage(withImageId);

    const has = await projectList(
      ctx.db,
      { search: "presence with", imagePresenceFilter: "has" },
      [],
      page,
    );
    expect(has.data.map((p) => p.id)).toEqual([withImage.id]);

    // "none" must return the complement — every other live project — not zero
    // rows, which is the NOT IN / NULL trap `idSetPresence` warns about.
    const none = await projectList(
      ctx.db,
      { imagePresenceFilter: "none" },
      [],
      page,
    );
    expect(none.data.map((p) => p.id)).toContain(withoutImage.id);
    expect(none.data.map((p) => p.id)).not.toContain(withImage.id);
  });

  it("counts a PDF-only, soft-deleted-image, or detached-association project as having no image", async () => {
    const cases = [
      {
        name: "presence pdf only",
        overrides: { contentType: PDF_CONTENT_TYPE },
      },
      { name: "presence image deleted", overrides: { imageDeleted: true } },
      { name: "presence join deleted", overrides: { joinDeleted: true } },
    ];
    const ids: string[] = [];
    for (const { name, overrides } of cases) {
      const { output, entityId } = await createProject(
        ctx.db,
        projectCreateInput.parse({ name }),
        ctx.actor,
      );
      await attachImage(entityId, overrides);
      ids.push(output.id);
    }

    const has = await projectList(
      ctx.db,
      { search: "presence", imagePresenceFilter: "has" },
      [],
      page,
    );
    expect(has.data).toHaveLength(0);

    const none = await projectList(
      ctx.db,
      { search: "presence", imagePresenceFilter: "none" },
      [],
      page,
    );
    expect(none.data.map((p) => p.id).sort()).toEqual([...ids].sort());
  });

  it("narrows the WBS tree page identically to the flat list", async () => {
    const { output: parent, entityId: parentId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "tree presence parent" }),
      ctx.actor,
    );
    await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "tree presence child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );
    await attachImage(parentId);

    const tree = await projectTreePage(
      ctx.db,
      { search: "tree presence", imagePresenceFilter: "has" },
      [],
      page,
    );
    // The child has no image of its own, so it must not ride along under its
    // matching parent — membership is the same predicate the flat list applies.
    expect(tree.data.map((p) => p.id)).toEqual([parent.id]);
    expect(tree.count).toBe(1);
  });
});
