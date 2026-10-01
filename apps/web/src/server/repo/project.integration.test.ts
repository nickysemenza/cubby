import { createProjectFromTasksInput } from "@cubby/schemas/project";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityLink } from "~/server/db/schema";
import { projectCreateFromTasksWorkflow } from "~/server/operations/project.server";
import { linkValues } from "~/server/repo/entity-links";

import { insertAndReturn } from "./database-helpers";
import {
  deleteProjects,
  getProjectByID,
  getProjectDependencyGraph,
  projectTreePage,
  updateProject,
} from "./project";
import { getTaskByShortcode, updateTask } from "./task";

describe("project repository", () => {
  const ctx = withTestDb();

  it("promotes tasks through the registered workflow and returns committed project membership", async () => {
    const task = await createRepoEntity(ctx, "task", {
      name: "Prepare test room",
      trade: "other",
    });
    const result = await projectCreateFromTasksWorkflow(
      ctx.db,
      createProjectFromTasksInput.parse({
        taskIds: [task.output.id],
        project: { name: "Workflow promotion project" },
      }),
      ctx.actor,
    );
    expect(result.project.name).toBe("Workflow promotion project");
    expect(result.tasks.map(({ id }) => id)).toEqual([task.output.id]);
    const saved = await getTaskByShortcode(ctx.db, task.output.id);
    expect(saved?.projectId).toBe(result.project.id);
  });

  it("rolls up spend (including future expenses) and task counts", async () => {
    const { output: project, entityId: projectEntityId } =
      await createRepoEntity(ctx, "project", { name: "test project rollup" });

    await createRepoEntity(ctx, "expense", {
      date: "2024-01-15",
      trade: "other",
      costType: "materials",
      name: "test expense made",
      projectId: project.id,
      cost: 100,
      future: false,
    });
    await createRepoEntity(ctx, "expense", {
      date: "2024-01-15",
      trade: "other",
      costType: "materials",
      name: "test expense future",
      projectId: project.id,
      cost: 50,
      future: true,
    });

    const { output: doneTask } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "test task done",
      projectId: project.id,
      status: "not_started",
    });
    await updateTask(ctx.db, doneTask.id, { status: "done" }, ctx.actor);
    await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "test task two",
      projectId: project.id,
    });
    await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "test task three",
      projectId: project.id,
    });

    const result = await getProjectByID(ctx.db, projectEntityId);
    expect(result.rollup).toEqual({
      spent: 150,
      actualSpent: 100,
      committedSpent: 50,
      credits: 0,
      expenseCount: 2,
      taskCount: 3,
      doneTaskCount: 1,
      subtree: {
        spent: 150,
        actualSpent: 100,
        committedSpent: 50,
        credits: 0,
        expenseCount: 2,
        taskCount: 3,
        doneTaskCount: 1,
        projectCount: 0,
        costEstimate: null,
      },
    });
  });

  it("returns a scoped subtree with direct dependency and hierarchy context", async () => {
    const { output: root, entityId: rootId } = await createRepoEntity(
      ctx,
      "project",
      { name: "graph root" },
    );
    const { output: child } = await createRepoEntity(ctx, "project", {
      name: "graph child",
      locations: ["Workshop", "Garden"],
      parentProjectId: root.id,
    });
    const { output: outside } = await createRepoEntity(ctx, "project", {
      name: "graph outside",
    });
    await updateProject(
      ctx.db,
      root.id,
      { blockedByIds: [outside.id] },
      ctx.actor,
    );

    const { output: parentTask } = await createRepoEntity(ctx, "task", {
      name: "graph parent task",
      projectId: child.id,
      trade: "other",
    });
    const { output: childTask } = await createRepoEntity(ctx, "task", {
      name: "graph child task",
      parentTaskId: parentTask.id,
      trade: "other",
    });
    const { output: blocker } = await createRepoEntity(ctx, "task", {
      name: "graph external blocker",
      projectId: outside.id,
      trade: "other",
    });
    await updateTask(
      ctx.db,
      childTask.id,
      { blockedByIds: [blocker.id] },
      ctx.actor,
    );

    const graph = await getProjectDependencyGraph(ctx.db, rootId);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(byId.get(root.id)).toMatchObject({
      external: false,
      kind: "project",
    });
    expect(byId.get(child.id)).toMatchObject({
      external: false,
      parentId: root.id,
      locations: ["Workshop", "Garden"],
    });
    expect(byId.get(parentTask.id)?.locations).toEqual(["Workshop", "Garden"]);
    expect(byId.get(root.id)?.locations).toEqual([]);
    expect(byId.get(outside.id)).toMatchObject({
      external: true,
      kind: "project",
    });
    expect(byId.get(blocker.id)).toMatchObject({
      external: true,
      parentId: outside.id,
    });
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: root.id, target: child.id, kind: "hierarchy" },
        { source: child.id, target: parentTask.id, kind: "hierarchy" },
        { source: parentTask.id, target: childTask.id, kind: "hierarchy" },
        { source: outside.id, target: root.id, kind: "dependency" },
        { source: blocker.id, target: childTask.id, kind: "dependency" },
      ]),
    );
  });

  it("includes inbox tasks when no project scope is selected", async () => {
    const { output: inbox } = await createRepoEntity(ctx, "task", {
      name: "graph inbox task",
      trade: "other",
    });

    expect((await getProjectDependencyGraph(ctx.db)).nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: inbox.id })]),
    );
  });

  it("rejects a dependency cycle against the whole projected graph", async () => {
    const { output: a, entityId: aId } = await createRepoEntity(
      ctx,
      "project",
      { name: "dependency cycle project a" },
    );
    const { output: b } = await createRepoEntity(ctx, "project", {
      name: "dependency cycle project b",
    });
    const { output: c } = await createRepoEntity(ctx, "project", {
      name: "dependency cycle project c",
    });
    await updateProject(ctx.db, a.id, { blockedByIds: [b.id] }, ctx.actor);
    await updateProject(ctx.db, b.id, { blockedByIds: [c.id] }, ctx.actor);

    await expect(
      updateProject(ctx.db, c.id, { blockedByIds: [a.id] }, ctx.actor),
    ).rejects.toMatchObject({ reason: "DEPENDENCY_CYCLE" });
    await expect(getProjectByID(ctx.db, aId)).resolves.toMatchObject({
      blockedByIds: [b.id],
    });
  });

  it("backstops self dependency with a database CHECK", async () => {
    const { entityId } = await createRepoEntity(ctx, "project", {
      name: "raw self dependency project",
    });

    await expect(
      insertAndReturn(
        ctx.db,
        entityLink,
        linkValues("projectDependency", entityId, entityId),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("blocks deletion while live tasks or expenses still reference the project", async () => {
    const { output: projectWithTask } = await createRepoEntity(ctx, "project", {
      name: "test project with task",
    });
    await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "test task blocking delete",
      projectId: projectWithTask.id,
    });
    await expect(
      deleteProjects(ctx.db, [projectWithTask.id], ctx.actor),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "PROJECT_HAS_TASKS",
    });

    const { output: projectWithExpense } = await createRepoEntity(
      ctx,
      "project",
      { name: "test project with expense" },
    );
    await createRepoEntity(ctx, "expense", {
      date: "2024-01-15",
      trade: "other",
      costType: "materials",
      name: "test expense blocking delete",
      projectId: projectWithExpense.id,
    });
    await expect(
      deleteProjects(ctx.db, [projectWithExpense.id], ctx.actor),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "PROJECT_HAS_EXPENSES",
    });
  });

  it("blocks deletion while a live sub-project still references it, succeeds once the child is gone", async () => {
    const { output: parent } = await createRepoEntity(ctx, "project", {
      name: "Sub-Project-Blocked Parent",
    });
    const { output: child } = await createRepoEntity(ctx, "project", {
      name: "Blocking Child",
      parentProjectId: parent.id,
    });

    await expect(
      deleteProjects(ctx.db, [parent.id], ctx.actor),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "ENTITY_DELETE_BLOCKED",
    });

    await deleteProjects(ctx.db, [child.id], ctx.actor);

    await expect(
      deleteProjects(ctx.db, [parent.id], ctx.actor),
    ).resolves.toMatchObject({ detachedImageKeys: [] });
  });
});

describe("project repository — sub-projects (parentProjectId)", () => {
  const ctx = withTestDb();

  it("rejects a cycle (A -> B -> C; making A a child of C) with PROJECT_CYCLE", async () => {
    const { output: a, entityId: aEntityId } = await createRepoEntity(
      ctx,
      "project",
      { name: "cycle a" },
    );
    const { output: b } = await createRepoEntity(ctx, "project", {
      name: "cycle b",
      parentProjectId: a.id,
    });
    const { output: c } = await createRepoEntity(ctx, "project", {
      name: "cycle c",
      parentProjectId: b.id,
    });

    await expect(
      updateProject(ctx.db, a.id, { parentProjectId: c.id }, ctx.actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const aAfter = await getProjectByID(ctx.db, aEntityId);
    expect(aAfter.parentProjectId).toBeNull();
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
});

describe("project repository — WBS tree page", () => {
  const ctx = withTestDb();

  const makeChain = async (prefix: string) => {
    const { output: parent } = await createRepoEntity(ctx, "project", {
      name: `${prefix} parent`,
    });
    const { output: child } = await createRepoEntity(ctx, "project", {
      name: `${prefix} child`,
      parentProjectId: parent.id,
      status: "done",
    });
    const { output: grandchild } = await createRepoEntity(ctx, "project", {
      name: `${prefix} grandchild`,
      parentProjectId: child.id,
    });
    return { parent, child, grandchild };
  };

  const page = (pageIndex: number, pageSize: number) => ({
    pageIndex,
    pageSize,
  });

  it("paginates by root, carrying descendants along with their root", async () => {
    const { parent, child, grandchild } = await makeChain("paged");
    const { output: standalone } = await createRepoEntity(ctx, "project", {
      name: "paged standalone",
    });

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
});

describe("project repository — date windows (derivation)", () => {
  const ctx = withTestDb();

  it("derives dates purely from own content when no override is set", async () => {
    const { output: project, entityId: projectEntityId } =
      await createRepoEntity(ctx, "project", { name: "dates content only" });
    await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "dates content task",
      projectId: project.id,
      dueDate: "2024-02-01",
      dueEndDate: "2024-02-03",
    });
    await createRepoEntity(ctx, "expense", {
      trade: "other",
      costType: "materials",
      name: "dates content expense",
      projectId: project.id,
      cost: 10,
      date: "2024-01-15",
    });

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

  // The create/update cycle guard (crud.ts's `wouldCreateProjectCycle`) means
  // a cyclic parent chain can never actually be persisted through the repo —
  // so this exercises `aggregateSubtreeDates` directly with a hand-built
  // cyclic row pair, the same white-box approach gantt-model.unit.test.ts and
  // project-tree.unit.test.ts use for their own cycle-termination tests.

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
});

/**
 * `projectPortfolioAnalytics` backs both the Analytics tab's charts and the
 * MCP `project_overview.budget` tool, and the only coverage it had was a mocked
 * unit test (`mcp/server.unit.test.ts`). These pin the two aggregates whose
 * numbers come out of the subtree rollup — `costVsEstimate` and
 * `spendingByProject` — against a parent/child pair with spend on BOTH, plus
 * the deliberate asymmetry with the expense-grouped aggregates (which are
 * scoped to a project's OWN expenses, never subtree-expanded).
 */

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
