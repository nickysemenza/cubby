import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/mutation-side-effects";
import { testShortcode } from "@cubby/schemas/testing";
import { fromAny } from "@total-typescript/shoehorn";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { auditLog, entityLink } from "~/server/db/schema";
import { taskBulkReorderWorkflow } from "~/server/domains/task/operations.server";
import {
  listActionableTasks,
  readTaskActionability,
} from "~/server/domains/task/repo/actionable";
import {
  getTaskByShortcode,
  updateTask,
} from "~/server/domains/task/repo/crud";
import { updateTasksInBulk } from "~/server/domains/task/repo/crud";
import { taskList } from "~/server/domains/task/repo/lookup";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityMutationCommand } from "~/server/entity-kernel/contracts";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/generic/search/repo/search-document";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("task reorder workflow", () => {
  const ctx = withTestDb();

  it("returns persisted ranks and dispatches effects after a successful reorder", async () => {
    const first = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "First ranked task",
    });
    const second = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "Second ranked task",
    });
    const result = await taskBulkReorderWorkflow(
      ctx.db,
      {
        ranks: [
          { id: first.output.id, sortOrder: 20 },
          { id: second.output.id, sortOrder: 10 },
        ],
      },
      ctx.actor,
    );
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.output.id, sortOrder: 20 }),
        expect.objectContaining({ id: second.output.id, sortOrder: 10 }),
      ]),
    );
    expect(result.sideEffects).toEqual(EMPTY_MUTATION_SIDE_EFFECTS);
    // The bulk-reorder workflow's effect step fans out entity-embedding
    // refreshes for both reordered tasks; with no queue bound in tests that
    // runs inline and refreshes the search-document projection first (see
    // refreshEntityEmbedding), so a live projection is the observable proof
    // the fanout ran.
    expect(
      await getSearchDocumentEmbeddingText(ctx.db, "task", first.entityId),
    ).not.toBeNull();
    expect((await getTaskByShortcode(ctx.db, first.output.id))?.sortOrder).toBe(
      20,
    );
    await expect(
      taskBulkReorderWorkflow(
        ctx.db,
        {
          ranks: [
            { id: first.output.id, sortOrder: 99 },
            { id: testShortcode("task", "missing-ranked-task"), sortOrder: 1 },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow(testShortcode("task", "missing-ranked-task"));
    expect((await getTaskByShortcode(ctx.db, first.output.id))?.sortOrder).toBe(
      20,
    );
  });
});

describe("task repository — scoped list search", () => {
  const ctx = withTestDb();

  it("intersects exact/text search with legacy and status filters before count and pagination", async () => {
    const exact = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "scope exact search",
      status: "done",
    });
    const prefixCompetitor = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: `alpha ${exact.output.id} scope alternate`,
      status: "done",
    });
    const pageRows = await Promise.all(
      ["one", "two", "three"].map((suffix) =>
        createRepoEntity(ctx, "task", {
          trade: "other",
          name: `scope page marker ${suffix}`,
          status: "done",
        }),
      ),
    );
    const excluded = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "scope page marker excluded",
      status: "not_started",
    });
    await Promise.all(
      [exact, prefixCompetitor, ...pageRows, excluded].map(({ entityId }) =>
        refreshSearchDocument(ctx.db, "task", entityId),
      ),
    );
    // The document is intentionally left untouched: list relevance must use
    // the source edit time, while exact shortcode eligibility still wins.
    await getDb(ctx.db).execute(sql`
      UPDATE "Task"
      SET "updatedAt" = now() + interval '1 day'
      WHERE "id" = ${prefixCompetitor.entityId}
    `);

    const exactFilters = {
      searchQuery: exact.output.id,
      search: "scope",
      status: "done" as const,
    };
    const relevance = await taskList(ctx.db, exactFilters, [], {
      pageIndex: 0,
      pageSize: 10,
    });
    expect(relevance.count).toBe(2);
    expect(relevance.data.map((row) => row.id)).toEqual([
      exact.output.id,
      prefixCompetitor.output.id,
    ]);

    const explicitSort = await taskList(
      ctx.db,
      exactFilters,
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(explicitSort.data.map((row) => row.id)).toEqual([
      prefixCompetitor.output.id,
      exact.output.id,
    ]);

    const pageFilters = {
      searchQuery: "scope page marker",
      search: "scope page",
      status: "done" as const,
    };
    const pageTwo = await taskList(ctx.db, pageFilters, [], {
      pageIndex: 2,
      pageSize: 1,
    });
    expect(pageTwo.count).toBe(3);
    expect(pageTwo.data).toHaveLength(1);
    expect(pageRows.map(({ output }) => output.id)).toContain(
      pageTwo.data[0]?.id,
    );
  });
});

describe("task repository — listActionableTasks", () => {
  const ctx = withTestDb();

  // Attention needs the same blocker policy without loading Task media,
  // quality, inherited presentation, or converting project UUIDs twice.
  it("reads attention membership with the same blocker states in five queries", async () => {
    const { output: next } = await createRepoEntity(ctx, "task", {
      name: "Synthetic next",
      trade: "other",
    });
    const { output: later } = await createRepoEntity(ctx, "task", {
      name: "Synthetic later",
      trade: "other",
      status: "later",
    });
    const { output: blocked } = await createRepoEntity(ctx, "task", {
      name: "Synthetic blocked",
      trade: "other",
    });
    const { output: manual } = await createRepoEntity(ctx, "task", {
      name: "Synthetic manual",
      trade: "other",
      status: "blocked",
    });
    const { output: child } = await createRepoEntity(ctx, "task", {
      name: "Synthetic checklist",
      trade: "other",
      parentTaskId: blocked.id,
    });
    const { output: done } = await createRepoEntity(ctx, "task", {
      name: "Synthetic done",
      trade: "other",
      status: "done",
    });
    await updateTask(
      ctx.db,
      blocked.id,
      { blockedByIds: [next.id] },
      ctx.actor,
    );
    await updateTask(ctx.db, next.id, { blockedByIds: [done.id] }, ctx.actor);
    const measured = await countTestDbQueries(() =>
      readTaskActionability(ctx.db),
    );
    const states = new Map(
      measured.result.map((row) => [row.shortcode, row.state]),
    );
    expect(states.get(next.id)).toBe("next");
    expect(states.get(later.id)).toBe("later");
    expect(states.get(blocked.id)).toBe("blocked");
    expect(states.get(manual.id)).toBe("blocked");
    expect(states.has(child.id)).toBe(false);
    expect(states.has(done.id)).toBe(false);
    const full = await listActionableTasks(ctx.db);
    expect(
      measured.result.map((row) => [row.shortcode, row.state]).sort(),
    ).toEqual(
      [
        ...full.next.map((row) => [row.id, "next"]),
        ...full.later.map((row) => [row.id, "later"]),
        ...full.blocked.map((row) => [row.task.id, "blocked"]),
      ].sort(),
    );
    expect(measured.queryCount).toBe(5);
  });

  it("keeps ancestor blockers across a done intermediate project without inheriting its own edges", async () => {
    const blocker = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic blocker",
      status: "in_progress",
    });
    const ancestor = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic ancestor",
      status: "in_progress",
    });
    const middle = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic completed middle",
      status: "done",
      parentProjectId: ancestor.id,
    });
    const leaf = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic leaf",
      status: "in_progress",
      parentProjectId: middle.id,
    });
    const doneRoot = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic completed root",
      status: "done",
    });
    const openLeaf = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic open leaf",
      status: "in_progress",
      parentProjectId: doneRoot.id,
    });
    await getDb(ctx.db)
      .insert(entityLink)
      .values([
        {
          kind: "projectDependency",
          fromKind: "project",
          toKind: "project",
          fromEntityId: ancestor.id,
          toEntityId: blocker.id,
        },
        {
          kind: "projectDependency",
          fromKind: "project",
          toKind: "project",
          fromEntityId: doneRoot.id,
          toEntityId: blocker.id,
        },
      ]);
    const inherited = await insertWithShortcode(ctx.db, "task", {
      name: "Synthetic inherited blocker",
      projectId: leaf.id,
      status: "not_started",
      trade: "other",
    });
    const ready = await insertWithShortcode(ctx.db, "task", {
      name: "Synthetic ready",
      projectId: openLeaf.id,
      status: "not_started",
      trade: "other",
    });
    const states = await readTaskActionability(ctx.db);
    expect(states.find((row) => row.id === inherited.id)).toMatchObject({
      projectId: leaf.id,
      state: "blocked",
    });
    expect(states.find((row) => row.id === ready.id)).toMatchObject({
      projectId: openLeaf.id,
      state: "next",
    });
    const full = await listActionableTasks(ctx.db);
    expect(
      full.blocked.find((row) => row.task.id === inherited.shortcode)?.reasons,
    ).toMatchObject([{ kind: "project", chain: [{ id: blocker.shortcode }] }]);
    expect(full.next.some((row) => row.id === ready.shortcode)).toBe(true);
  });

  it("builds the transitive chain (A blocked by B, B blocked by C -> A's chain = [B, C])", async () => {
    const { output: c } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "task c",
    });
    const { output: b } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "task b",
    });
    const { output: a } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "task a",
    });
    await updateTask(ctx.db, b.id, { blockedByIds: [c.id] }, ctx.actor);
    await updateTask(ctx.db, a.id, { blockedByIds: [b.id] }, ctx.actor);

    const result = await listActionableTasks(ctx.db);
    const row = result.blocked.find((r) => r.task.id === a.id);

    expect(row?.reasons).toHaveLength(1);
    expect(row?.reasons[0]?.chain.map((n) => n.id)).toEqual([b.id, c.id]);
  });

  it("serializes opposite dependency writes so only one side can commit", async () => {
    const { output: a } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "dependency race a",
    });
    const { output: b } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "dependency race b",
    });

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
});

describe("task repository — subtasks (parentTaskId)", () => {
  const ctx = withTestDb();

  it("rejects a parent that is itself a subtask — only one level of nesting", async () => {
    const { output: grandparent } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "grandparent",
    });
    const { output: parent } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "parent",
      parentTaskId: grandparent.id,
    });

    await expect(
      createRepoEntity(ctx, "task", {
        trade: "other",
        name: "grandchild",
        parentTaskId: parent.id,
      }),
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
    const { output: task } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "atomic task patch",
    });

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
    const { output: parent } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "delete parent",
    });
    const { output: subtask } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "delete child",
      parentTaskId: parent.id,
    });

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
          edge: "EntityLink[taskDependency].from",
          effect: "soft-delete",
          changed: 0,
        },
        {
          edge: "EntityLink[taskDependency].to",
          effect: "soft-delete",
          changed: 0,
        },
      ]),
    );
  });

  it("refuses half a due-date window rather than nulling the other half", async () => {
    const { output: t } = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "kernel due window",
      dueDate: "2024-03-01",
      dueEndDate: "2024-03-05",
    });

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

describe("updateTasksInBulk status patch", () => {
  const ctx = withTestDb();

  it("accepts mixed selections, audits only changes, and refuses a missing ID", async () => {
    const changed = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "Bulk status pending",
    });
    const unchanged = await createRepoEntity(ctx, "task", {
      trade: "other",
      name: "Bulk status already done",
      status: "done",
    });
    const ids = [changed.output.id, unchanged.output.id];

    for (const _attempt of [1, 2]) {
      expect(
        (await updateTasksInBulk(ctx.db, ids, { status: "done" }, ctx.actor))
          .updatedShortcodes,
      ).toEqual(expect.arrayContaining(ids));
    }

    const changedId = await resolveLiveShortcode(
      ctx.db,
      changed.output.id,
      "task",
    );
    const unchangedId = await resolveLiveShortcode(
      ctx.db,
      unchanged.output.id,
      "task",
    );
    if (!changedId || !unchangedId) throw new Error("task fixture missing");
    const audits = await getDb(ctx.db)
      .select({ entityId: auditLog.entityId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "task"),
          eq(auditLog.action, "update"),
          inArray(auditLog.entityId, [changedId, unchangedId]),
        ),
      );
    expect(audits.filter((audit) => audit.entityId === changedId)).toHaveLength(
      1,
    );
    expect(
      audits.filter((audit) => audit.entityId === unchangedId),
    ).toHaveLength(0);

    await expect(
      updateTasksInBulk(
        ctx.db,
        [changed.output.id, testShortcode("task", "TSK-MISSING")],
        { status: "done" },
        ctx.actor,
      ),
    ).rejects.toThrow(testShortcode("task", "TSK-MISSING"));
  });
});
