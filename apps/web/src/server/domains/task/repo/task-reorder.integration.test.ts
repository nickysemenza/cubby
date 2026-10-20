import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { task } from "~/server/db/schema";

import { reorderTasks, getTaskByShortcode } from "./crud";

// The client sends only a page: rank collisions and an unranked page must preserve
// rows outside it. A failed placement must also roll back its destination patch.
describe("server-owned task placement", () => {
  const ctx = withTestDb();
  it.each([
    { label: "degenerate ranks", values: [1024, 2048, 2048, 4096, 5120] },
    { label: "unranked page", values: [8192, null, null, null, 9216] },
  ])("preserves unseen neighbors for $label", async ({ values }) => {
    const project = await createRepoEntity(ctx, "project", {
      name: "Shelf tasks",
      defaultTrade: "building",
    });
    const records = [];
    for (const [index, sortOrder] of values.entries()) {
      const row = await createRepoEntity(ctx, "task", {
        name: `Shelf step ${index}`,
        projectId: project.output.id,
        sortOrder,
      });
      await getDb(ctx.db)
        .update(task)
        .set({
          sortOrder,
          updatedAt: new Date("2026-01-01T00:00:00Z"),
          createdAt: new Date(Date.UTC(2026, 0, 10 - index)),
        })
        .where(eq(task.shortcode, row.output.id));
      records.push(row.output);
    }
    const [outside, left, right, later, moved] = records;
    if (!outside || !left || !right || !later || !moved)
      throw new Error("Missing fixture task");
    await reorderTasks(
      ctx.db,
      {
        ranks: [],
        position: {
          id: moved.id,
          before: right.id,
          after: left.id,
          group: { projectId: project.output.id },
        },
      },
      ctx.actor,
    );
    const readTask = async (id: typeof moved.id) => {
      const row = await getTaskByShortcode(ctx.db, id);
      if (!row) throw new Error(`Missing task ${id}`);
      return row;
    };
    const read = await Promise.all(records.map((row) => readTask(row.id)));
    const ranks = new Map(read.map((row) => [row.id, row.sortOrder]));
    expect(ranks.get(outside.id)).toBeLessThan(ranks.get(left.id)!);
    expect(ranks.get(left.id)).toBeLessThan(ranks.get(moved.id)!);
    expect(ranks.get(moved.id)).toBeLessThan(ranks.get(right.id)!);
    expect(
      ranks.get(later.id) === null ||
        ranks.get(right.id)! < ranks.get(later.id)!,
    ).toBe(true);
    expect(read.find((row) => row.id === outside.id)?.updatedAt).toEqual(
      new Date("2026-01-01T00:00:00Z"),
    );
    // The destination patch cannot survive an invalid anchor.
    await expect(
      reorderTasks(
        ctx.db,
        {
          ranks: [],
          position: {
            id: moved.id,
            before: left.id,
            group: { status: "done" },
          },
          move: { id: moved.id, patch: { status: "done" } },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/anchor/iu);
    expect((await readTask(moved.id)).status).toBe(moved.status);
  });
  it("moves into No project and rolls back when clearing the only trade source", async () => {
    const project = await createRepoEntity(ctx, "project", {
      name: "Placement project",
      defaultTrade: "building",
    });
    const explicit = await createRepoEntity(ctx, "task", {
      name: "Explicit trade",
      projectId: project.output.id,
      trade: "building",
    });
    await reorderTasks(
      ctx.db,
      {
        ranks: [],
        position: { id: explicit.output.id, group: { projectId: null } },
        move: { id: explicit.output.id, patch: { projectId: null } },
      },
      ctx.actor,
    );
    expect(
      (await getTaskByShortcode(ctx.db, explicit.output.id))?.projectId,
    ).toBeNull();
    const inherited = await createRepoEntity(ctx, "task", {
      name: "Inherited trade",
      projectId: project.output.id,
      trade: null,
    });
    await expect(
      reorderTasks(
        ctx.db,
        {
          ranks: [],
          position: { id: inherited.output.id, group: { projectId: null } },
          move: { id: inherited.output.id, patch: { projectId: null } },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/trade/iu);
    const stored = await getDb(ctx.db).query.task.findFirst({
      where: eq(task.shortcode, inherited.output.id),
    });
    expect(stored?.projectId).not.toBeNull();
    expect(stored?.trade).toBeNull();
  });
});
