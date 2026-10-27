import type { ProductCategoryFilters } from "@cubby/schemas/product-category";
import type { ProjectFilters, TaskFilters } from "@cubby/schemas/project";
import { rawTaskOut } from "@cubby/schemas/work-raw-read";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyId } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb, unwrapDb } from "~/server/db/helpers";
import { project as projectTable, task as taskTable } from "~/server/db/schema";
import { productCategoryScaffold } from "~/server/domains/product-category/repo/product-category";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import { taskScaffold } from "~/server/domains/task/repo/lookup";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { loadFieldResolutionEvidence } from "~/server/generic/suggestions/repo/field-resolution-evidence";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createProductIdentityFixture,
  listInventoryFixture,
  listProductsFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  effectiveFieldSql,
  inheritedFieldDecisionSchema,
  inheritedFieldDecisionSql,
  inheritedFieldSql,
  inheritedSourceSql,
} from "./effective-field";

const page = { pageIndex: 0, pageSize: 100 };

/**
 * Inherited values (`resolution.inherit`) compile one effective value for
 * reads, filters, sorts and groups. Each case's expected rows are the ones
 * the hand-written predicates returned before the declaration replaced them
 * (plan rows 19–26), except the task rows named as intended changes.
 * Failure modes: a task field stops at the parent instead of the nearest
 * deciding ancestor; a task assignee skips its effective project default
 * or an explicit None default; a deleted parent still donates; project and
 * category walks stop at the parent or ignore an explicit None (`blocked`);
 * Exclude drops rows with no value; a read, its provenance, and its filter
 * disagree.
 */
describe("inherited values", () => {
  const ctx = withTestDb();
  const db = () => ctx.db;

  const projectWorld = async () => {
    const member = (name: string) =>
      insertWithShortcode(db(), "ledgerParty", { name, kind: "member" });
    const a = await member("Inherit member A");
    const b = await member("Inherit member B");
    type ProjectRow = Awaited<ReturnType<typeof insertProject>>;
    const insertProject = (
      name: string,
      values: {
        parent?: { id: string };
        assignee?: { id: string } | null;
        locations?: string[];
      },
    ) =>
      insertWithShortcode(db(), "project", {
        name,
        parentProjectId: (values.parent?.id ?? null) as never,
        assigneeMode: values.assignee === undefined ? "inherit" : "explicit",
        assigneeId: (values.assignee?.id ?? null) as never,
        locationsMode: values.locations === undefined ? "inherit" : "explicit",
        locations: values.locations ?? [],
        defaultTrade: "other",
      });
    const p1 = await insertProject("Inherit P1", {
      assignee: a,
      locations: ["Inherit garage"],
    });
    const p2 = await insertProject("Inherit P2", { parent: p1 });
    const p3 = await insertProject("Inherit P3", {
      assignee: null,
      locations: [],
    });
    const p4 = await insertProject("Inherit P4", {});
    const p5 = await insertProject("Inherit P5", { parent: p3 });
    const p6 = await insertProject("Inherit P6", { parent: p2 });
    const p7 = await insertProject("Inherit P7", {
      parent: p1,
      assignee: b,
      locations: ["Inherit shed"],
    });
    const projects: ProjectRow[] = [p1, p2, p3, p4, p5, p6, p7];
    return { a, b, p1, p2, p3, p4, p5, p6, p7, projects };
  };

  it("previews clearing only local intent and distinguishes an ancestor None from no decision", async () => {
    const w = await projectWorld();
    const read = async (id: string) => {
      const row = { id: sql`${id}::uuid` };
      const result = await unwrapDb(db()).execute(sql`SELECT
        ${inheritedFieldDecisionSql("project", "assigneeId", row)} AS decision,
        ${inheritedFieldSql("project", "assigneeId", row)} AS fallback,
        ${inheritedSourceSql("project", "assigneeId", row)} AS source,
        ${effectiveFieldSql("project", "assigneeId", row)} AS effective`);
      const first = result.rows[0];
      if (!first) throw new Error("Expected the selected project");
      return z
        .object({
          decision: inheritedFieldDecisionSchema,
          fallback: z.uuid().nullable(),
          source: z.object({ position: z.number(), id: z.uuid() }).nullable(),
          effective: z.uuid().nullable(),
        })
        .parse(first);
    };
    const own = await read(w.p7.id);
    expect(own.effective).toBe(w.b.id);
    expect(own.decision).toEqual({
      kind: "value",
      value: w.a.id,
      source: { entityKind: "project", entityId: w.p1.id },
    });
    expect(own.fallback).toBe(w.a.id);
    expect(own.source).toMatchObject({ position: 1, id: w.p1.id });
    expect((await read(w.p5.id)).decision).toEqual({
      kind: "empty",
      reason: "explicit_none",
      source: { entityKind: "project", entityId: w.p3.id },
    });
    expect((await read(w.p4.id)).decision).toEqual({
      kind: "empty",
      reason: "unset",
      source: null,
    });
    await getDb(db())
      .update(projectTable)
      .set({ assigneeId: null, assigneeMode: "inherit" })
      .where(eq(projectTable.id, w.p7.id));
    expect((await read(w.p7.id)).effective).toBe(own.fallback);
    expect((await read(w.p1.id)).effective).toBe(w.a.id);
  });

  it("retains the terminal Project identity through a Task's effective Project path", async () => {
    const w = await projectWorld();
    const task = await insertWithShortcode(db(), "task", {
      name: "Synthetic preview task",
      projectId: w.p6.id,
      projectMode: "explicit",
      assigneeId: w.b.id,
      assigneeMode: "explicit",
      trade: "other",
    });
    const row = { id: sql`${task.id}::uuid` };
    const result = await unwrapDb(db()).execute(sql`SELECT
      ${inheritedFieldDecisionSql("task", "assigneeId", row)} AS decision,
      ${inheritedFieldSql("task", "assigneeId", row)} AS fallback,
      ${inheritedSourceSql("task", "assigneeId", row)} AS source`);
    const first = result.rows[0];
    if (!first) throw new Error("Expected the selected task");
    expect(inheritedFieldDecisionSchema.parse(first.decision)).toEqual({
      kind: "value",
      value: w.a.id,
      source: { entityKind: "project", entityId: w.p1.id },
    });
    expect(first.fallback).toBe(w.a.id);
    expect(first.source).toMatchObject({ position: 2, id: w.p1.id });
    await getDb(db())
      .update(taskTable)
      .set({ projectId: w.p5.id })
      .where(eq(taskTable.id, task.id));
    const none = await unwrapDb(db()).execute(sql`SELECT
      ${inheritedFieldDecisionSql("task", "assigneeId", row)} AS decision`);
    expect(inheritedFieldDecisionSchema.parse(none.rows[0]?.decision)).toEqual({
      kind: "empty",
      reason: "explicit_none",
      source: { entityKind: "project", entityId: w.p3.id },
    });
  });

  it("keeps an unassigned array default distinct from an ancestor's explicitly empty array", async () => {
    const w = await projectWorld();
    const read = async (id: string) => {
      const result = await unwrapDb(db()).execute(sql`SELECT
        ${inheritedFieldDecisionSql("project", "locations", { id: sql`${id}::uuid` })} AS decision`);
      return inheritedFieldDecisionSchema.parse(result.rows[0]?.decision);
    };
    expect(await read(w.p4.id)).toEqual({
      kind: "value",
      value: [],
      source: null,
    });
    expect(await read(w.p5.id)).toEqual({
      kind: "value",
      value: [],
      source: { entityKind: "project", entityId: w.p3.id },
    });
    expect(await read(w.p7.id)).toEqual({
      kind: "value",
      value: ["Inherit garage"],
      source: { entityKind: "project", entityId: w.p1.id },
    });
  });

  it("refuses a cardholder preview on a bank account while preserving the member source on a card", async () => {
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic preview account owner",
      kind: "member",
    });
    const card = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "credit_card", network: null },
      ledgerPartyId: owner.output.id,
    });
    const bank = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "bank_account", accountType: "checking" },
      ledgerPartyId: owner.output.id,
    });
    const result = await unwrapDb(db()).execute(sql`SELECT f.shortcode,
      ${inheritedFieldDecisionSql("financialAccount", "primaryCardholderId", "f")} AS decision,
      ${inheritedFieldSql("financialAccount", "primaryCardholderId", "f")} AS fallback
      FROM "FinancialAccount" f WHERE f.shortcode IN (${card.output.id}, ${bank.output.id})`);
    const rows = new Map(
      result.rows.map((row) => [
        row.shortcode,
        {
          decision: inheritedFieldDecisionSchema.parse(row.decision),
          fallback: row.fallback,
        },
      ]),
    );
    expect(rows.get(bank.output.id)?.decision).toEqual({
      kind: "empty",
      reason: "not_applicable",
      source: null,
    });
    const selected = rows.get(card.output.id);
    expect(selected?.fallback).toEqual(expect.any(String));
    expect(selected?.decision).toMatchObject({
      kind: "value",
      value: selected?.fallback,
      source: { entityKind: "ledgerParty", entityId: selected?.fallback },
    });
  });

  it("filters projects by their inherited assignee and locations", async () => {
    const w = await projectWorld();
    const ids = new Set<string>(w.projects.map((row) => row.shortcode));
    const listed = async (filters: ProjectFilters) =>
      (
        await projectScaffold.read(db(), {
          filters,
          sorts: [],
          pagination: page,
        })
      ).data
        .map((row) => row.id)
        .filter((id) => ids.has(id))
        .sort();
    const codes = (...rows: { shortcode: string }[]) =>
      rows.map((row) => row.shortcode).sort();
    const cases: Array<[ProjectFilters, string[]]> = [
      [{ assigneeId: [w.a.shortcode] }, codes(w.p1, w.p2, w.p6)],
      [{ assigneeId: [w.b.shortcode] }, codes(w.p7)],
      [{ assigneeIdPresenceFilter: "none" }, codes(w.p3, w.p4, w.p5)],
      [{ assigneeIdPresenceFilter: "has" }, codes(w.p1, w.p2, w.p6, w.p7)],
      [{ assigneeIdExclude: [w.a.shortcode] }, codes(w.p3, w.p4, w.p5, w.p7)],
      [{ location: ["Inherit garage"] }, codes(w.p1, w.p2, w.p6)],
      [{ location: ["Inherit shed"] }, codes(w.p7)],
      [{ locationsExclude: ["Inherit garage"] }, codes(w.p3, w.p4, w.p5, w.p7)],
    ];
    for (const [filters, expected] of cases)
      expect({ filters, ids: await listed(filters) }).toEqual({
        filters,
        ids: expected,
      });
  });

  it("reads, explains and filters tasks by the nearest deciding ancestor", async () => {
    const w = await projectWorld();
    const subject = await createProductFixture(
      db(),
      makeProductInput({ name: "Inherit subject" }),
      ctx.actor,
    );
    type Mode = "inherit" | "explicit";
    const insertTask = (
      name: string,
      values: {
        parent?: { id: string };
        project?: [Mode, { id: string } | null];
        assignee?: [Mode, { id: string } | null];
        subject?: [Mode, { id: string } | null];
      },
    ) =>
      insertWithShortcode(db(), "task", {
        name,
        parentTaskId: (values.parent?.id ?? null) as never,
        projectMode: values.project?.[0] ?? "inherit",
        projectId: (values.project?.[1]?.id ?? null) as never,
        assigneeMode: values.assignee?.[0] ?? "inherit",
        assigneeId: (values.assignee?.[1]?.id ?? null) as never,
        subjectProductMode: values.subject?.[0] ?? "inherit",
        subjectProductId: (values.subject?.[1]?.id ?? null) as never,
        trade: "other",
      });
    const x = { id: subject.entityId };
    const t1 = await insertTask("Inherit T1", {
      project: ["explicit", w.p2],
      subject: ["explicit", x],
    });
    const t2 = await insertTask("Inherit T2", { parent: t1 });
    const t3 = await insertTask("Inherit T3", { parent: t2 });
    const t4 = await insertTask("Inherit T4", {
      parent: t1,
      project: ["explicit", w.p3],
    });
    const t5p = await insertTask("Inherit T5p", {
      project: ["explicit", w.p3],
    });
    const t5 = await insertTask("Inherit T5", {
      parent: t5p,
      project: ["explicit", w.p1],
    });
    const t6 = await insertTask("Inherit T6", {
      parent: t1,
      assignee: ["explicit", w.b],
    });
    const t7 = await insertTask("Inherit T7", {
      project: ["explicit", w.p1],
      assignee: ["explicit", null],
    });
    const t8 = await insertTask("Inherit T8", { parent: t6 });
    const t9 = await insertTask("Inherit T9", {
      project: ["explicit", w.p4],
    });
    // A stored project in inherit mode still wins (explicitIfSet).
    const t10 = await insertTask("Inherit T10", {
      parent: t1,
      project: ["inherit", w.p7],
    });
    const gone = await insertTask("Inherit deleted parent", {
      project: ["explicit", w.p1],
      assignee: ["explicit", w.b],
      subject: ["explicit", x],
    });
    await getDb(db())
      .update(taskTable)
      .set({ deletedAt: new Date() })
      .where(eq(taskTable.id, gone.id));
    const t11 = await insertTask("Inherit T11", { parent: gone });
    const t12 = await insertTask("Inherit T12", {
      project: ["explicit", w.p6],
    });
    const tasks = [t1, t2, t3, t4, t5p, t5, t6, t7, t8, t9, t10, t11, t12];
    const ids = new Set<string>(tasks.map((row) => row.shortcode));
    const listed = async (filters: TaskFilters) =>
      (
        await taskScaffold.read(db(), { filters, sorts: [], pagination: page })
      ).data
        .filter((row) => ids.has(row.id))
        .map((row) => rawTaskOut.parse(row));
    const listedIds = async (filters: TaskFilters) =>
      (await listed(filters)).map((row) => row.id).sort();
    const codes = (...rows: { shortcode: string }[]) =>
      rows.map((row) => row.shortcode).sort();
    const product = subject.id;
    const effective = new Map(
      (await listed({})).map((row) => [
        row.id,
        [row.projectId, row.assigneeId, row.subjectProductId],
      ]),
    );
    const { a, b, p1, p2, p3, p4, p6, p7 } = w;
    // Each task field reads the nearest ancestor task that sets its own
    // value; the assignee then falls back to the task's effective project
    // default. Rows marked "changed" are the intended differences from the
    // old one-level chains (#2606); every other row reads as before.
    expect(Object.fromEntries(effective)).toEqual({
      [t1.shortcode]: [p2.shortcode, a.shortcode, product],
      [t2.shortcode]: [p2.shortcode, a.shortcode, product],
      // Changed: a grandchild under an inheriting parent reads the
      // grandparent's project and product (was none).
      [t3.shortcode]: [p2.shortcode, a.shortcode, product],
      // Changed: parent and child on different projects; the child's own
      // project default (an explicit None) decides, not the parent's.
      [t4.shortcode]: [p3.shortcode, null, product],
      [t5p.shortcode]: [p3.shortcode, null, null],
      // Changed: the parent's project None no longer blocks the child's
      // own project default.
      [t5.shortcode]: [p1.shortcode, a.shortcode, null],
      [t6.shortcode]: [p2.shortcode, b.shortcode, product],
      [t7.shortcode]: [p1.shortcode, null, null],
      // Changed: a grandchild under an inheriting parent (was none).
      [t8.shortcode]: [p2.shortcode, b.shortcode, product],
      [t9.shortcode]: [p4.shortcode, null, null],
      // Changed: its own project P7's default, not the parent's P2's.
      [t10.shortcode]: [p7.shortcode, b.shortcode, product],
      // A deleted parent donates nothing.
      [t11.shortcode]: [null, null, null],
      [t12.shortcode]: [p6.shortcode, a.shortcode, null],
    });
    // Provenance names the record that decided, from the same rule.
    const resolutions = new Map(
      (await listed({})).map((row) => [row.id, row.fieldResolutions]),
    );
    expect(resolutions.get(t3.shortcode)?.projectId).toMatchObject({
      mode: "inherit",
      source: "Ancestor task",
      sourceEntity: { entityKind: "task", entityId: t1.shortcode },
      value: p2.shortcode,
      fallbackValue: p2.shortcode,
    });
    expect(resolutions.get(t8.shortcode)?.assigneeId).toMatchObject({
      source: "Parent task",
      sourceEntity: { entityKind: "task", entityId: t6.shortcode },
    });
    expect(resolutions.get(t5.shortcode)?.assigneeId).toMatchObject({
      source: "Project default",
      sourceEntity: { entityKind: "project", entityId: p1.shortcode },
      value: a.shortcode,
    });
    expect(resolutions.get(t11.shortcode)?.projectId).toMatchObject({
      source: "Unassigned",
      sourceEntity: null,
    });
    const cases: Array<[TaskFilters, string[]]> = [
      [{ assigneeId: [a.shortcode] }, codes(t1, t2, t3, t5, t12)],
      [{ assigneeId: [b.shortcode] }, codes(t6, t8, t10)],
      [{ assigneeIdPresenceFilter: "none" }, codes(t4, t5p, t7, t9, t11)],
      [
        { assigneeIdExclude: [a.shortcode] },
        codes(t4, t5p, t6, t7, t8, t9, t10, t11),
      ],
      [
        { projectId: [p1.shortcode] },
        codes(t1, t2, t3, t5, t6, t7, t8, t10, t12),
      ],
      [{ projectId: [p1.shortcode], includeSubProjects: false }, codes(t5, t7)],
      [{ projectIdPresenceFilter: "none" }, codes(t11)],
      [
        { projectIdExclude: [p2.shortcode] },
        codes(t4, t5p, t5, t7, t9, t10, t11),
      ],
      [{ subjectProductId: [product] }, codes(t1, t2, t3, t4, t6, t8, t10)],
      [
        { subjectProductIdPresenceFilter: "none" },
        codes(t5p, t5, t7, t9, t11, t12),
      ],
      [
        { subjectProductIdExclude: [product] },
        codes(t5p, t5, t7, t9, t11, t12),
      ],
    ];
    for (const [filters, expected] of cases)
      expect({ filters, ids: await listedIds(filters) }).toEqual({
        filters,
        ids: expected,
      });
  });

  /**
   * Task trade walks its ancestors only while they share the task's
   * effective project (`whileSame`), then reads that project's default.
   * Failure modes: an ancestor on another project donates; the walk skips
   * past a different-project ancestor to a matching one above it; a
   * grandparent's trade is ignored under an inheriting parent (the old
   * one-parent rule, the intended change); the project default skips the
   * project hierarchy; the filter reads the stored column; provenance or
   * the explanation names a different record than the value.
   */
  it("reads, explains and filters task trade along same-project ancestors", async () => {
    const insertProject = (
      name: string,
      defaultTrade: "building" | "plumbing" | null,
      parent?: { id: string },
    ) =>
      insertWithShortcode(db(), "project", {
        name,
        parentProjectId: (parent?.id ?? null) as never,
        defaultTrade,
      });
    const pa = await insertProject("Trade PA", "building");
    const pac = await insertProject("Trade PA child", null, pa);
    const pb = await insertProject("Trade PB", "plumbing");
    const insertTask = (
      name: string,
      values: {
        parent?: { id: string };
        project?: { id: string };
        trade?: "electrical" | "landscaping";
      },
    ) =>
      insertWithShortcode(db(), "task", {
        name,
        parentTaskId: (values.parent?.id ?? null) as never,
        projectMode: values.project ? "explicit" : "inherit",
        projectId: (values.project?.id ?? null) as never,
        trade: values.trade ?? null,
      });
    const t1 = await insertTask("Trade T1", {
      project: pa,
      trade: "electrical",
    });
    const t2 = await insertTask("Trade T2", { parent: t1 });
    const t3 = await insertTask("Trade T3", { parent: t2 });
    const t4 = await insertTask("Trade T4", { parent: t1, project: pb });
    const t5 = await insertTask("Trade T5", { parent: t4 });
    const t6 = await insertTask("Trade T6", { parent: t1, project: pac });
    const t7 = await insertTask("Trade T7", {
      parent: t1,
      trade: "landscaping",
    });
    // Same project as T1, but under T4 on another project: the walk stops.
    const t8 = await insertTask("Trade T8", { parent: t4, project: pa });
    const gone = await insertTask("Trade deleted parent", {
      project: pa,
      trade: "electrical",
    });
    await getDb(db())
      .update(taskTable)
      .set({ deletedAt: new Date() })
      .where(eq(taskTable.id, gone.id));
    const t9 = await insertTask("Trade T9", { parent: gone, project: pa });
    const tasks = [t1, t2, t3, t4, t5, t6, t7, t8, t9];
    const ids = new Set<string>(tasks.map((row) => row.shortcode));
    const listed = async (filters: TaskFilters) =>
      (
        await taskScaffold.read(db(), { filters, sorts: [], pagination: page })
      ).data
        .filter((row) => ids.has(row.id))
        .map((row) => rawTaskOut.parse(row));
    const codes = (...rows: { shortcode: string }[]) =>
      rows.map((row) => row.shortcode).sort();
    const rows = await listed({});
    expect(Object.fromEntries(rows.map((row) => [row.id, row.trade]))).toEqual({
      [t1.shortcode]: "electrical",
      [t2.shortcode]: "electrical",
      // Changed: the grandparent's trade, as its inheriting parent reads
      // (was the project default "building").
      [t3.shortcode]: "electrical",
      [t4.shortcode]: "plumbing",
      [t5.shortcode]: "plumbing",
      // Another project: its default, inherited from PA.
      [t6.shortcode]: "building",
      [t7.shortcode]: "landscaping",
      [t8.shortcode]: "building",
      [t9.shortcode]: "building",
    });
    const resolutions = new Map(
      rows.map((row) => [row.id, row.fieldResolutions?.trade]),
    );
    expect(resolutions.get(t2.shortcode)).toMatchObject({
      mode: "inherit",
      source: "Parent task",
      sourceEntity: { entityKind: "task", entityId: t1.shortcode },
      fallbackValue: "electrical",
    });
    expect(resolutions.get(t3.shortcode)).toMatchObject({
      source: "Ancestor task",
      sourceEntity: { entityKind: "task", entityId: t1.shortcode },
      value: "electrical",
      fallbackValue: "electrical",
    });
    // The project that set the default, as the assignee's provenance names.
    expect(resolutions.get(t6.shortcode)).toMatchObject({
      source: "Project default",
      sourceEntity: { entityKind: "project", entityId: pa.shortcode },
      fallbackValue: "building",
    });
    expect(resolutions.get(t7.shortcode)).toMatchObject({
      mode: "explicit",
      source: "Task override",
      fallbackValue: "electrical",
      canReset: true,
    });
    const explained = await loadFieldResolutionEvidence(
      db(),
      "task",
      t3.shortcode,
      "trade",
      resolutions.get(t3.shortcode) ?? null,
    );
    expect(explained.evidence?.fallbackSource).toMatchObject({
      entityKind: "task",
      entityId: t1.shortcode,
    });
    const blocked = await loadFieldResolutionEvidence(
      db(),
      "task",
      t5.shortcode,
      "trade",
      resolutions.get(t5.shortcode) ?? null,
    );
    expect(blocked.evidence?.fallbackSource).toMatchObject({
      entityKind: "project",
      entityId: pb.shortcode,
    });
    const cases: Array<[TaskFilters, string[]]> = [
      [{ trade: ["electrical"] }, codes(t1, t2, t3)],
      [{ trade: ["building"] }, codes(t6, t8, t9)],
      [{ tradeExclude: ["building", "electrical"] }, codes(t4, t5, t7)],
    ];
    for (const [filters, expected] of cases)
      expect({
        filters,
        ids: (await listed(filters)).map((row) => row.id).sort(),
      }).toEqual({ filters, ids: expected });
  });

  it("filters categories, products and inventory by inherited category values", async () => {
    const spending = (name: string, parentId: string | null = null) =>
      insertWithShortcode(db(), "spendingCategory", {
        name,
        parentId: parentId as never,
      });
    const s1 = await spending("Inherit S1");
    const s1c = await spending("Inherit S1 child", s1.id);
    const category = (
      name: string,
      values: {
        parent?: { id: string };
        spending?: { id: string } | "blocked";
      },
    ) =>
      insertWithShortcode(db(), "productCategory", {
        name,
        parentId: (values.parent?.id ?? null) as never,
        feature: null,
        spendingCategoryMode:
          values.spending === undefined
            ? "inherit"
            : values.spending === "blocked"
              ? "blocked"
              : "mapped",
        spendingCategoryId: (typeof values.spending === "object"
          ? values.spending.id
          : null) as never,
      });
    // Features are unique per live category, so the walks start below the
    // seeded Food and Tools roots (a tree is at most three levels deep).
    const food = { id: taxonomyId("food") };
    const tools = { id: taxonomyId("tools") };
    const c1 = await category("Inherit C1", { parent: food, spending: s1 });
    const c2 = await category("Inherit C2", { parent: c1 });
    // Past the declared depth: Food is three levels up, so no feature.
    const c3 = await category("Inherit C3", { parent: c2 });
    const c4 = await category("Inherit C4", {
      parent: tools,
      spending: "blocked",
    });
    const c5 = await category("Inherit C5", {});
    const c6 = await category("Inherit C6", { parent: c4 });
    const c7 = await category("Inherit C7", { parent: c1, spending: s1c });
    const categories = [c1, c2, c3, c4, c5, c6, c7];
    const categoryIds = new Set<string>(categories.map((row) => row.shortcode));
    const codes = (...rows: { shortcode: string }[]) =>
      rows.map((row) => row.shortcode).sort();
    const listedCategories = async (filters: ProductCategoryFilters) =>
      (
        await productCategoryScaffold.read(db(), {
          filters,
          sorts: [],
          pagination: page,
        })
      ).data
        .map((row) => row.id)
        .filter((id) => categoryIds.has(id))
        .sort();
    const categoryCases: Array<[ProductCategoryFilters, string[]]> = [
      [{ effectiveSpendingCategoryId: [s1.shortcode] }, codes(c1, c2, c3, c7)],
      [
        {
          effectiveSpendingCategoryId: [s1.shortcode],
          includeSubSpendingCategories: false,
        },
        codes(c1, c2, c3),
      ],
      [{ effectiveSpendingCategoryId: [s1c.shortcode] }, codes(c7)],
      // `blocked` is an explicit None that stops the walk.
      [{ effectiveSpendingCategoryPresenceFilter: "none" }, codes(c4, c5, c6)],
      [{ effectiveSpendingCategoryExclude: [s1.shortcode] }, codes(c4, c5, c6)],
    ];
    for (const [filters, expected] of categoryCases)
      expect({ filters, ids: await listedCategories(filters) }).toEqual({
        filters,
        ids: expected,
      });

    const shelf = await createLocationFixture(
      db(),
      makeLocationInput({ name: "Inherit shelf", type: "shelf" }),
      ctx.actor,
    );
    const product = async (name: string, from?: { shortcode: string }) => {
      const created = await createProductIdentityFixture(
        db(),
        makeProductInput(
          from === undefined
            ? { name }
            : { name, categoryId: from.shortcode as never },
        ),
        ctx.actor,
      );
      const stock = await createInventoryFixture(
        db(),
        {
          productId: created.id as never,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      return { shortcode: created.id, stock: stock.id };
    };
    const products = {
      c1: await product("Inherit in C1", c1),
      c2: await product("Inherit in C2", c2),
      c3: await product("Inherit in C3", c3),
      c4: await product("Inherit in C4", c4),
      c5: await product("Inherit in C5", c5),
      c6: await product("Inherit in C6", c6),
      c7: await product("Inherit in C7", c7),
      none: await product("Inherit uncategorized"),
    };
    const all = Object.values(products);
    const productIds = new Set(all.map((row) => row.shortcode));
    const stockIds = new Set(all.map((row) => row.stock));
    const listedProducts = async (
      filters: Parameters<typeof listProductsFixture>[1],
    ) =>
      (await listProductsFixture(db(), filters, [], page)).data
        .map((row) => row.id)
        .filter((id) => productIds.has(id))
        .sort();
    const stockOf = new Map<string, string>(
      all.map((row) => [row.shortcode, row.stock]),
    );
    const listedStock = async (
      filters: Parameters<typeof listInventoryFixture>[1],
    ) =>
      (await listInventoryFixture(db(), filters, [], page)).data
        .map((row) => row.id)
        .filter((id) => stockIds.has(id))
        .sort();
    const p = products;
    const productCases: Array<
      [Parameters<typeof listProductsFixture>[1], string[]]
    > = [
      [{ categoryFeatureFilter: ["food"] }, codes(p.c1, p.c2, p.c7)],
      [{ categoryFeatureFilter: ["tools"] }, codes(p.c4, p.c6)],
      [
        { categoryFeatureExclude: ["food"] },
        codes(p.c3, p.c4, p.c5, p.c6, p.none),
      ],
      // Behavior change (plan §14.3): No value is "no effective feature",
      // not "no category".
      [{ categoryFeaturePresenceFilter: "none" }, codes(p.c3, p.c5, p.none)],
      [
        { categoryFeaturePresenceFilter: "has" },
        codes(p.c1, p.c2, p.c4, p.c6, p.c7),
      ],
    ];
    for (const [filters, expected] of productCases) {
      expect({ filters, ids: await listedProducts(filters) }).toEqual({
        filters,
        ids: expected,
      });
      expect({
        filters,
        ids: await listedStock(filters as never),
      }).toEqual({
        filters,
        ids: expected.map((code) => stockOf.get(code)).sort(),
      });
    }
  });
});
