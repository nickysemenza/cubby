import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { fakerFromSeed, hashSeed } from "tooling/factories/faker";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { executeEntity } from "~/server/entity-kernel";
import { ENTITY_LIST_READ_OPERATIONS } from "~/server/generated/entity-list-read-bindings.gen";

/**
 * The server owns tree nesting: `roots` and `children` are judged against the
 * whole filtered set, never a loaded page, and each nested row's
 * `childCount` counts only its children that match the same filters.
 */
describe("list nesting scope", () => {
  const ctx = withTestDb();

  const kernel = () => buildKernelContext(ctx.db, testUserId(TEST_USER_ID));
  const runCode = async (id: Awaited<ReturnType<typeof ensureRun>>) => {
    const [row] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, id));
    if (!row) throw new Error(`Run ${id} was not created`);
    return row.shortcode;
  };

  /** A background parent with one background and one AI child, plus an AI root. */
  const seedRuns = async () => {
    const parentId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const sameChild = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      parentRunId: parentId,
    });
    const otherChild = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      parentRunId: parentId,
    });
    const root = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    return {
      parentId,
      parent: await runCode(parentId),
      sameChild: await runCode(sameChild),
      otherChild: await runCode(otherChild),
      root: await runCode(root),
    };
  };

  const readRuns = (input: {
    filters?: { purpose?: string[] };
    nesting?: unknown;
    pageIndex?: number;
    pageSize?: number;
  }) =>
    ENTITY_LIST_READ_OPERATIONS.run.base(kernel(), {
      filters: input.filters ?? {},
      sort: [{ orderBy: "startedAt", direction: "asc" }],
      pagination: {
        pageIndex: input.pageIndex ?? 0,
        pageSize: input.pageSize ?? 25,
      },
      nesting: input.nesting,
    });
  // Runs started in the same millisecond tie on the sort, so compare sets.
  const outline = (rows: readonly { id: unknown; childCount?: unknown }[]) =>
    rows
      .map((row) => [String(row.id), row.childCount] as const)
      .sort(([left], [right]) => left.localeCompare(right));
  const sorted = (...rows: (readonly [string, number])[]) =>
    rows.sort(([left], [right]) => left.localeCompare(right));

  it("pages roots with their filtered child counts", async () => {
    const runs = await seedRuns();
    const roots = await readRuns({ nesting: { scope: "roots" } });
    expect(outline(roots.data)).toEqual(
      sorted([runs.parent, 2], [runs.root, 0]),
    );
    expect(roots.meta.totalCount).toBe(2);

    // Child counts hold on every page, not just the one holding the children.
    const pages = await Promise.all(
      [0, 1].map((pageIndex) =>
        readRuns({ nesting: { scope: "roots" }, pageIndex, pageSize: 1 }),
      ),
    );
    expect(pages.map((page) => page.data.length)).toEqual([1, 1]);
    expect(pages.map((page) => page.meta.totalCount)).toEqual([2, 2]);
    expect(outline(pages.flatMap((page) => page.data))).toEqual(
      sorted([runs.parent, 2], [runs.root, 0]),
    );
  });

  it("reads one parent's children with their own paging", async () => {
    const runs = await seedRuns();
    const children = { scope: "children", parentId: runs.parent };
    const first = await readRuns({ nesting: children, pageSize: 1 });
    const second = await readRuns({
      nesting: children,
      pageIndex: 1,
      pageSize: 1,
    });
    expect(first.meta.totalCount).toBe(2);
    expect(outline([...first.data, ...second.data])).toEqual(
      sorted([runs.sameChild, 0], [runs.otherChild, 0]),
    );

    // A filtered child scope keeps only the matching child.
    const filtered = await readRuns({
      nesting: children,
      filters: { purpose: ["background"] },
    });
    expect(outline(filtered.data)).toEqual([[runs.sameChild, 0]]);
    expect(filtered.meta.totalCount).toBe(1);
  });

  it("keeps a matching child whose parent is filtered out as a root", async () => {
    const runs = await seedRuns();
    const ai = await readRuns({
      nesting: { scope: "roots" },
      filters: { purpose: ["ai_suggest"] },
    });
    expect(outline(ai.data)).toEqual(
      sorted([runs.otherChild, 0], [runs.root, 0]),
    );
    const mail = await readRuns({
      nesting: { scope: "roots" },
      filters: { purpose: ["background"] },
    });
    // The parent counts only the child that matches the same filters.
    expect(outline(mail.data)).toEqual([[runs.parent, 1]]);
  });

  it("promotes the children of a deleted parent to roots", async () => {
    const runs = await seedRuns();
    await getDb(ctx.db)
      .update(runTable)
      .set({ deletedAt: new Date() })
      .where(eq(runTable.id, runs.parentId));
    const roots = await readRuns({ nesting: { scope: "roots" } });
    expect(outline(roots.data)).toEqual(
      sorted([runs.sameChild, 0], [runs.otherChild, 0], [runs.root, 0]),
    );
  });

  it("stays flat by default and over the kernel list read", async () => {
    const runs = await seedRuns();
    const flat = await readRuns({});
    expect(flat.meta.totalCount).toBe(4);
    expect(flat.data.every((row) => !("childCount" in row))).toBe(true);

    const listed = await executeEntity(kernel(), {
      action: "list",
      entity: "run",
      filters: {},
      sort: [{ orderBy: "startedAt", direction: "asc" }],
      nesting: { scope: "roots" },
    });
    if (listed.action !== "list") throw new Error("Wrong list action");
    expect(outline(listed.items)).toEqual(
      sorted([runs.parent, 2], [runs.root, 0]),
    );
  });

  it("nests product categories and refuses nesting without a list tree", async () => {
    const context = kernel();
    const faker = fakerFromSeed(hashSeed("list-nesting"));
    const pantry = await createEntity(
      context,
      "productCategory",
      { name: "Nesting pantry" },
      { faker },
    );
    const spices = await createEntity(
      context,
      "productCategory",
      { name: "Nesting spices", parentId: pantry.id },
      { faker },
    );
    const operation = ENTITY_LIST_READ_OPERATIONS.productCategory;
    const roots = await operation.base(context, {
      filters: { search: "Nesting" },
      nesting: { scope: "roots" },
    });
    expect(outline(roots.data)).toEqual([[pantry.id, 1]]);
    // The complete list read (MCP, HTTP, the hierarchy chart) re-parses each
    // row with the entity's output schema; `childCount` must survive it.
    const listed = await executeEntity(context, {
      action: "list",
      entity: "productCategory",
      filters: { search: "Nesting" },
      nesting: { scope: "roots" },
    });
    if (listed.action !== "list") throw new Error("Wrong list action");
    expect(outline(listed.items)).toEqual([[pantry.id, 1]]);
    // A search match whose parent does not match stays reachable as a root.
    const orphan = await operation.base(context, {
      filters: { search: "spices" },
      nesting: { scope: "roots" },
    });
    expect(outline(orphan.data)).toEqual([[spices.id, 0]]);

    await expect(
      ENTITY_LIST_READ_OPERATIONS.product.base(context, {
        filters: {},
        nesting: { scope: "roots" },
      }),
    ).rejects.toThrow(/declares no list.tree/);
  });
});
