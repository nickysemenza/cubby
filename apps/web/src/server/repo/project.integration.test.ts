import { unsafeProjectId } from "@cubby/schemas/identifiers";
import type { ProjectCreateInput } from "@cubby/schemas/project";
import {
  LIVE_PROJECT_STATUSES,
  projectCreateInput,
  purchaseCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { eq, or } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { image, projectDependency, projectImage } from "~/server/db/schema";
import { getDb, insertAndReturn } from "./database-helpers";
import {
  computeAttentionItems,
  createProject,
  deleteProjects,
  getProjectByID,
  projectDashboardSummary,
  projectList,
  updateProject,
} from "./project";
import { createPurchase, purchaseList } from "./purchase";
import { createTask, updateTask } from "./task";

describe("project repository", () => {
  const ctx = withTestDb();

  it("creates a project and surfaces it in the list", async () => {
    const created = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "test project a",
        status: "in_progress",
        locations: ["Cabin"],
      }),
      ctx.actor,
    );

    expect(created.name).toBe("test project a");
    expect(created.status).toBe("in_progress");
    expect(created.locations).toEqual(["Cabin"]);
    expect(created.rollup).toEqual({
      spent: 0,
      actualSpent: 0,
      committedSpent: 0,
      contributions: 0,
      purchaseCount: 0,
      taskCount: 0,
      doneTaskCount: 0,
      subtree: {
        spent: 0,
        actualSpent: 0,
        committedSpent: 0,
        contributions: 0,
        purchaseCount: 0,
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

  it("rolls up spend (including future purchases) and task counts", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project rollup" }),
      ctx.actor,
    );

    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "test purchase made",
        projectId: project.id,
        cost: 100,
        future: false,
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "test purchase future",
        projectId: project.id,
        cost: 50,
        future: true,
      }),
      ctx.actor,
    );

    const doneTask = await createTask(
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

    const result = await getProjectByID(ctx.db, project.id);
    // spent includes the future purchase — matches the retired Notion rollup's
    // semantics (a planned spend still counts toward the running total).
    // subtree equals own here — this project is a leaf (no sub-projects).
    expect(result.rollup).toEqual({
      spent: 150,
      actualSpent: 100,
      committedSpent: 50,
      contributions: 0,
      purchaseCount: 2,
      taskCount: 3,
      doneTaskCount: 1,
      subtree: {
        spent: 150,
        actualSpent: 100,
        committedSpent: 50,
        contributions: 0,
        purchaseCount: 2,
        taskCount: 3,
        doneTaskCount: 1,
        projectCount: 0,
        costEstimate: null,
      },
    });
  });

  it("replaces the blockedByIds dependency set on update, both directions readable", async () => {
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project b" }),
      ctx.actor,
    );
    const projectC = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project c" }),
      ctx.actor,
    );

    const updatedA = await updateProject(
      ctx.db,
      projectA.id,
      { blockedByIds: [projectB.id, projectC.id] },
      ctx.actor,
    );
    expect(new Set(updatedA.blockedByIds)).toEqual(
      new Set([projectB.id, projectC.id]),
    );

    const projectBAfter = await getProjectByID(ctx.db, projectB.id);
    expect(projectBAfter.blockingIds).toEqual([projectA.id]);

    // Replace the set (drop C, keep B) — full replacement, not an append.
    const updatedAgain = await updateProject(
      ctx.db,
      projectA.id,
      { blockedByIds: [projectB.id] },
      ctx.actor,
    );
    expect(updatedAgain.blockedByIds).toEqual([projectB.id]);

    const projectCAfter = await getProjectByID(ctx.db, projectC.id);
    expect(projectCAfter.blockingIds).toEqual([]);
  });

  it("rejects a self-reference in blockedByIds", async () => {
    const projectA = await createProject(
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
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project dedupe a" }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project dedupe b" }),
      ctx.actor,
    );

    const updated = await updateProject(
      ctx.db,
      projectA.id,
      { blockedByIds: [projectB.id, projectB.id] },
      ctx.actor,
    );
    expect(updated.blockedByIds).toEqual([projectB.id]);

    const edges = await getDb(ctx.db)
      .select()
      .from(projectDependency)
      .where(eq(projectDependency.projectId, projectA.id));
    expect(edges).toHaveLength(1);
  });

  it("rejects a nonexistent id in blockedByIds with NOT_FOUND (not a raw 500)", async () => {
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project missing dep" }),
      ctx.actor,
    );
    const missingId = unsafeProjectId("00000000-0000-0000-0000-000000000000");

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
    const projectWithImage = await createProject(
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
      projectId: projectWithImage.id,
      imageId: img.id,
    });

    await deleteProjects(ctx.db, [projectWithImage.id], ctx.actor);

    const after = await getDb(ctx.db).query.projectImage.findFirst({
      where: eq(projectImage.id, projImg.id),
    });
    expect(after?.deletedAt).not.toBeNull();
  });

  it("blocks deletion while live tasks or purchases still reference the project", async () => {
    const projectWithTask = await createProject(
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

    const projectWithPurchase = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project with purchase" }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "test purchase blocking delete",
        projectId: projectWithPurchase.id,
      }),
      ctx.actor,
    );
    await expect(
      deleteProjects(ctx.db, [projectWithPurchase.id], ctx.actor),
    ).rejects.toThrow(/still have purchases/);
  });

  it("hard-deletes dependency edges (both directions) when a project is deleted", async () => {
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project a" }),
      ctx.actor,
    );
    const projectB = await createProject(
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

    // B has no tasks/purchases, so deleting it is allowed even though A still
    // references it — the dependency edge is hard-deleted, not a delete guard.
    await deleteProjects(ctx.db, [projectB.id], ctx.actor);

    const remainingEdges = await getDb(ctx.db)
      .select()
      .from(projectDependency)
      .where(
        or(
          eq(projectDependency.projectId, projectB.id),
          eq(projectDependency.blockedByProjectId, projectB.id),
        ),
      );
    expect(remainingEdges).toHaveLength(0);

    const projectAAfter = await getProjectByID(ctx.db, projectA.id);
    expect(projectAAfter.blockedByIds).toEqual([]);
  });
});

describe("project repository — sub-projects (parentProjectId)", () => {
  const ctx = withTestDb();

  it("sets, changes, and clears parentProjectId", async () => {
    const parentA = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "parent a" }),
      ctx.actor,
    );
    const parentB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "parent b" }),
      ctx.actor,
    );

    const created = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "child at create",
        parentProjectId: parentA.id,
      }),
      ctx.actor,
    );
    expect(created.parentProjectId).toBe(parentA.id);
    expect(created.parentProjectName).toBe(parentA.name);

    const parentAAfter = await getProjectByID(ctx.db, parentA.id);
    expect(parentAAfter.childProjectIds).toEqual([created.id]);

    const changed = await updateProject(
      ctx.db,
      created.id,
      { parentProjectId: parentB.id },
      ctx.actor,
    );
    expect(changed.parentProjectId).toBe(parentB.id);
    expect(changed.parentProjectName).toBe(parentB.name);

    const parentAAfterMove = await getProjectByID(ctx.db, parentA.id);
    expect(parentAAfterMove.childProjectIds).toEqual([]);

    const cleared = await updateProject(
      ctx.db,
      created.id,
      { parentProjectId: null },
      ctx.actor,
    );
    expect(cleared.parentProjectId).toBeNull();
    expect(cleared.parentProjectName).toBeNull();
  });

  it("rejects a nonexistent or soft-deleted parentProjectId with NOT_FOUND", async () => {
    const missingId = unsafeProjectId("00000000-0000-0000-0000-000000000000");
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

    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project not-found parent" }),
      ctx.actor,
    );
    const deletedParent = await createProject(
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
    const project = await createProject(
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
    const a = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "cycle a" }),
      ctx.actor,
    );
    const b = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "cycle b", parentProjectId: a.id }),
      ctx.actor,
    );
    const c = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "cycle c", parentProjectId: b.id }),
      ctx.actor,
    );

    // C is a descendant of A — making A a child of C would create a cycle.
    await expect(
      updateProject(ctx.db, a.id, { parentProjectId: c.id }, ctx.actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Unaffected: the original chain still holds.
    const aAfter = await getProjectByID(ctx.db, a.id);
    expect(aAfter.parentProjectId).toBeNull();
  });

  it("rejects deletion while live child projects still reference the parent, succeeds once reparented away", async () => {
    const parent = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "parent with child" }),
      ctx.actor,
    );
    const child = await createProject(
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

    const parentAfter = await getProjectByID(ctx.db, child.id).catch((e) => e);
    expect(parentAfter).toBeDefined();
  });

  it("accumulates subtree rollups over 3 levels; a leaf's subtree equals its own numbers", async () => {
    const grandparent = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "subtree grandparent" }),
      ctx.actor,
    );
    const parent = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "subtree parent",
        parentProjectId: grandparent.id,
      }),
      ctx.actor,
    );
    const leaf = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "subtree leaf",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );

    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "grandparent purchase",
        projectId: grandparent.id,
        cost: 10,
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "parent purchase",
        projectId: parent.id,
        cost: 20,
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "leaf purchase",
        projectId: leaf.id,
        cost: 40,
      }),
      ctx.actor,
    );

    const leafDoneTask = await createTask(
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

    const leafAfter = await getProjectByID(ctx.db, leaf.id);
    expect(leafAfter.rollup.subtree).toEqual({
      spent: leafAfter.rollup.spent,
      actualSpent: leafAfter.rollup.actualSpent,
      committedSpent: leafAfter.rollup.committedSpent,
      contributions: leafAfter.rollup.contributions,
      purchaseCount: leafAfter.rollup.purchaseCount,
      taskCount: leafAfter.rollup.taskCount,
      doneTaskCount: leafAfter.rollup.doneTaskCount,
      projectCount: 0,
      costEstimate: leafAfter.costEstimate,
    });
    expect(leafAfter.rollup.subtree.spent).toBe(40);

    const parentAfter = await getProjectByID(ctx.db, parent.id);
    expect(parentAfter.rollup.subtree).toEqual({
      spent: 60, // 20 (own) + 40 (leaf)
      actualSpent: 60, // all non-future, positive
      committedSpent: 0,
      contributions: 0,
      purchaseCount: 2,
      taskCount: 3, // 1 own + 2 leaf
      doneTaskCount: 1,
      projectCount: 1, // leaf
      costEstimate: null,
    });

    const grandparentAfter = await getProjectByID(ctx.db, grandparent.id);
    expect(grandparentAfter.rollup.subtree).toEqual({
      spent: 70, // 10 (own) + 20 (parent) + 40 (leaf)
      actualSpent: 70,
      committedSpent: 0,
      contributions: 0,
      purchaseCount: 3,
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
    const parent = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "estimate parent", costEstimate: 100 }),
      ctx.actor,
    );
    const child = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "estimate child",
        parentProjectId: parent.id,
        costEstimate: 50,
      }),
      ctx.actor,
    );

    expect(
      (await getProjectByID(ctx.db, parent.id)).rollup.subtree.costEstimate,
    ).toBe(150);

    // A leaf's subtree estimate is just its own.
    const childAfter = await getProjectByID(ctx.db, child.id);
    expect(childAfter.rollup.subtree.costEstimate).toBe(
      childAfter.costEstimate,
    );
    expect(childAfter.rollup.subtree.costEstimate).toBe(50);

    // Parent unestimated, child estimated — the child's value still surfaces.
    await updateProject(ctx.db, parent.id, { costEstimate: null }, ctx.actor);
    expect(
      (await getProjectByID(ctx.db, parent.id)).rollup.subtree.costEstimate,
    ).toBe(50);

    // Nothing in the subtree estimated — null, not 0.
    await updateProject(ctx.db, child.id, { costEstimate: null }, ctx.actor);
    const allNull = await getProjectByID(ctx.db, parent.id);
    expect(allNull.rollup.subtree.costEstimate).toBeNull();
  });

  it("filters the list by topLevelOnly and parentProjectId", async () => {
    const parent = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "filter parent" }),
      ctx.actor,
    );
    const child = await createProject(
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

  it("includeSubProjects expands the purchase filter to the whole subtree", async () => {
    const parent = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "subtree filter parent" }),
      ctx.actor,
    );
    const child = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "subtree filter child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );
    const grandchild = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "subtree filter grandchild",
        parentProjectId: child.id,
      }),
      ctx.actor,
    );

    for (const [project, name] of [
      [parent, "parent purchase"],
      [child, "child purchase"],
      [grandchild, "grandchild purchase"],
    ] as const) {
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
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

    // Direct-only (flag unset): just the parent's own purchase.
    const directOnly = await purchaseList(
      ctx.db,
      { projectId: parent.id },
      [],
      pagination,
    );
    expect(directOnly.count).toBe(1);
    expect(directOnly.data.map((p) => p.name)).toEqual(["parent purchase"]);

    // Subtree: parent + child + grandchild.
    const subtree = await purchaseList(
      ctx.db,
      { projectId: parent.id, includeSubProjects: true },
      [],
      pagination,
    );
    expect(subtree.count).toBe(3);
    expect(new Set(subtree.data.map((p) => p.name))).toEqual(
      new Set(["parent purchase", "child purchase", "grandchild purchase"]),
    );
  });
});

describe("project dashboard — attention detector + summary", () => {
  const ctx = withTestDb();

  it("flags missing_budget only for a project with spend and no estimate", async () => {
    const noEstimate = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "attention no estimate" }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "spend with no estimate",
        projectId: noEstimate.id,
        cost: 75,
        future: false,
      }),
      ctx.actor,
    );

    const withEstimate = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "attention with estimate",
        costEstimate: 500,
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
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
    const blockedProject = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "attention blocked project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const blockedTask = await createTask(
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
    const unblockedProject = await createProject(
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

  it("an omitted statusScope includes `done` projects in the list and in actualSpend/committedSpend", async () => {
    const projectA = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "summary spend a",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const projectB = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "summary spend b", status: "planning" }),
      ctx.actor,
    );
    const projectDone = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "summary spend done", status: "done" }),
      ctx.actor,
    );
    for (const [project, name, cost, future] of [
      [projectA, "summary a actual", 120, false],
      [projectA, "summary a committed", 30, true],
      [projectB, "summary b actual", 40, false],
      [projectDone, "summary done actual", 90, false],
      [projectDone, "summary done committed", 10, true],
    ] as const) {
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
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
      getProjectByID(ctx.db, projectA.id),
      getProjectByID(ctx.db, projectB.id),
      getProjectByID(ctx.db, projectDone.id),
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
  const mkProject = (input: Partial<ProjectCreateInput> & { name: string }) =>
    createProject(ctx.db, projectCreateInput.parse(input), ctx.actor);

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

  it("hiddenByDate counts scoped and inbox rows that lack a date, but not rows outside the scope", async () => {
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
      ["hidden scoped purchase", scoped.id, null],
      ["hidden inbox purchase", null, null],
      ["hidden other kind purchase", otherKind.id, null],
      ["hidden dated purchase", scoped.id, "2025-03-15"],
    ] as const) {
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
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
    // projects: the undated renovation project. tasks/purchases: the scoped
    // row + the inbox row. The garden project's rows are NOT counted — they
    // are hidden by the kind filter, not by the date window.
    expect(summary.hiddenByDate).toEqual({
      projects: 1,
      tasks: 2,
      purchases: 2,
    });

    // Nothing is "hidden by date" when no window is set.
    const unwindowed = await projectDashboardSummary(ctx.db, {
      kinds: ["renovation"],
    });
    expect(unwindowed.hiddenByDate).toEqual({
      projects: 0,
      tasks: 0,
      purchases: 0,
    });
  });

  it("filterOptions.years unions purchase/task/project dates, newest first, using a task's EFFECTIVE due date", async () => {
    await mkProject({
      name: "years project",
      startDate: "2020-02-01",
      endDate: "2022-03-01",
    });
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "years purchase",
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
    // 2023 (task dueEndDate) > 2022 (project end) > 2021 (purchase) > 2020
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
