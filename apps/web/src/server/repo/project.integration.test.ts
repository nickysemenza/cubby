import {
  projectCreateInput,
  purchaseCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { eq, or } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { projectDependency } from "~/server/db/schema";
import { getDb } from "./database-helpers";
import {
  createProject,
  deleteProjects,
  getProjectByID,
  projectList,
  updateProject,
} from "./project";
import { createPurchase } from "./purchase";
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
      purchaseCount: 0,
      taskCount: 0,
      doneTaskCount: 0,
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
        name: "test task done",
        projectId: project.id,
        status: "not_started",
      }),
      ctx.actor,
    );
    await updateTask(ctx.db, doneTask.id, { status: "done" }, ctx.actor);
    await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "test task two", projectId: project.id }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "test task three", projectId: project.id }),
      ctx.actor,
    );

    const result = await getProjectByID(ctx.db, project.id);
    // spent includes the future purchase — matches the retired Notion rollup's
    // semantics (a planned spend still counts toward the running total).
    expect(result.rollup).toEqual({
      spent: 150,
      purchaseCount: 2,
      taskCount: 3,
      doneTaskCount: 1,
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

  it("blocks deletion while live tasks or purchases still reference the project", async () => {
    const projectWithTask = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project with task" }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "test task blocking delete",
        projectId: projectWithTask.id,
      }),
      ctx.actor,
    );
    await expect(
      deleteProjects(ctx.db, [projectWithTask.id], ctx.actor),
    ).rejects.toThrow(/active tasks/);

    const projectWithPurchase = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "test project with purchase" }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        name: "test purchase blocking delete",
        projectId: projectWithPurchase.id,
      }),
      ctx.actor,
    );
    await expect(
      deleteProjects(ctx.db, [projectWithPurchase.id], ctx.actor),
    ).rejects.toThrow(/purchases/);
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
