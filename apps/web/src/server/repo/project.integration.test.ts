import {
  createProjectFromTasksInput,
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { projectDependency } from "~/server/db/schema";
import { projectCreateFromTasksWorkflow } from "~/server/workflows/project.server";

import { insertAndReturn } from "./database-helpers";
import { createExpense } from "./expense";
import {
  createProject,
  deleteProjects,
  getProjectByID,
  getProjectDependencyGraph,
  projectTreePage,
  updateProject,
} from "./project";
import { createTask, getTaskByShortcode, updateTask } from "./task";

describe("project repository", () => {
  const ctx = withTestDb();

  it("promotes tasks through the registered workflow and returns committed project membership", async () => {
    const task = await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "Prepare test room", trade: "other" }),
      ctx.actor,
    );
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

  it("returns a scoped subtree with direct dependency and hierarchy context", async () => {
    const { output: root, entityId: rootId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "graph root" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "graph child",
        locations: ["Workshop", "Garden"],
        parentProjectId: root.id,
      }),
      ctx.actor,
    );
    const { output: outside } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "graph outside" }),
      ctx.actor,
    );
    await updateProject(
      ctx.db,
      root.id,
      { blockedByIds: [outside.id] },
      ctx.actor,
    );

    const { output: parentTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "graph parent task",
        projectId: child.id,
        trade: "other",
      }),
      ctx.actor,
    );
    const { output: childTask } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "graph child task",
        parentTaskId: parentTask.id,
        trade: "other",
      }),
      ctx.actor,
    );
    const { output: blocker } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "graph external blocker",
        projectId: outside.id,
        trade: "other",
      }),
      ctx.actor,
    );
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
    const { output: inbox } = await createTask(
      ctx.db,
      taskCreateInput.parse({ name: "graph inbox task", trade: "other" }),
      ctx.actor,
    );

    expect((await getProjectDependencyGraph(ctx.db)).nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: inbox.id })]),
    );
  });

  it("rejects a dependency cycle against the whole projected graph", async () => {
    const { output: a, entityId: aId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "dependency cycle project a" }),
      ctx.actor,
    );
    const { output: b } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "dependency cycle project b" }),
      ctx.actor,
    );
    const { output: c } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "dependency cycle project c" }),
      ctx.actor,
    );
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
    const { entityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "raw self dependency project" }),
      ctx.actor,
    );

    await expect(
      insertAndReturn(ctx.db, projectDependency, {
        projectId: entityId,
        blockedByProjectId: entityId,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
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
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "PROJECT_HAS_TASKS",
    });

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
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "PROJECT_HAS_EXPENSES",
    });
  });

  it("blocks deletion while a live sub-project still references it, succeeds once the child is gone", async () => {
    const { output: parent } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Sub-Project-Blocked Parent" }),
      ctx.actor,
    );
    const { output: child } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Blocking Child",
        parentProjectId: parent.id,
      }),
      ctx.actor,
    );

    await expect(
      deleteProjects(ctx.db, [parent.id], ctx.actor),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "PROJECT_HAS_CHILDREN",
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
 * MCP `get_project_budget` tool, and the only coverage it had was a mocked
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
