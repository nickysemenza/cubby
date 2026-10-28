import { entitySchema } from "@cubby/schemas/entity-core";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project-fields";
import { testUserId } from "@cubby/schemas/testing";
import {
  workDiagnosticFacts,
  type WorkDiagnosticFacts,
} from "@cubby/schemas/work-diagnostic-facts";
import {
  workQueueInput,
  type WorkQueueInput,
  type WorkFamily,
  type WorkExecutor,
} from "@cubby/schemas/work-queue";
import { CURRENT_MEMBER_FILTER } from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { user } from "~/server/db/auth.schema";
import { derivedTriggerDdl } from "~/server/db/derived-trigger-ddl";
import { getDb } from "~/server/db/helpers";
import { project, financialAccount } from "~/server/db/schema";
import { loadWorkDiagnosticFacts } from "~/server/domains/work/repo/work-diagnostic-facts";
import {
  diagnosticWorkSources,
  computeWorkDiagnosticFacts,
} from "~/server/domains/work/service/work-diagnostics";
import { readWorkQueue as readComposedQueue } from "~/server/domains/work/service/work-queue-read";
import { resolveFilterTokens } from "~/server/entity-kernel/filter-tokens";
import { markAllStoredDerived } from "~/server/generic/derived/repo/drain";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { drainStoredDerived } from "~/server/testing/background-queue";
import { publishAllQualityFixtures } from "~/server/testing/quality.fixtures";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { readRecordWorkQueueWith, readWorkQueueWith } from "./work-queue";
import { selectWorkCandidates, type WorkSource } from "./work-source";

type Row = {
  key: string;
  name?: string;
  reasons: string[];
  owners?: (string | null)[];
  shared?: boolean;
  executor?: WorkExecutor;
  amount?: number | null;
  date?: string | null;
};

// These synthetic sources exercise the real SQL engine without coupling every
// filter and page assertion to a domain's changing eligibility policy.
const fakeSource = (
  id: string,
  rows: Row[],
  options: {
    family?: WorkFamily;
    executor?: WorkExecutor | "dynamic";
    entity?: WorkSource["entity"];
  } = {},
): WorkSource => {
  const source: WorkSource = {
    id,
    family: options.family ?? "problem",
    executor: options.executor ?? "human",
    entity: options.entity ?? null,
    reasons: ["a", "b", "c"].map((key) => ({ key, label: `Reason ${key}` })),
    link: { kind: "reason" },
    actions: [
      {
        id: `${id}:repair`,
        label: "Repair group",
        scope: "group",
        target: "canonical-query",
      },
    ],
    candidates: vi.fn(async (db) => ({
      query: selectWorkCandidates(db, source, {
        entity: null,
        id: null,
        key: sql`fixture.key`,
        name: sql`fixture.name`,
        reason: "Synthetic reason",
        reasonKeys: sql`fixture.reasons`,
        executor:
          source.executor === "dynamic" ? sql`fixture.executor` : undefined,
        owners: sql`fixture.owners`,
        shared: sql`fixture.shared`,
        amount: sql`fixture.amount`,
        date: sql`fixture.date`,
      }).from(
        sql`jsonb_to_recordset(${JSON.stringify(rows.map((row) => ({ name: row.key, owners: [], shared: false, amount: null, date: null, ...row })))}::jsonb) AS fixture(key text, name text, reasons text[], owners uuid[], shared boolean, executor text, amount double precision, date date)`,
      ),
    })),
  };
  return source;
};

describe("composed Work queue engine", () => {
  const ctx = withTestDb();
  const read = (
    sources: WorkSource[],
    input: WorkQueueInput = {},
    deferrals: ReturnType<typeof sql>[] = [],
  ) =>
    readWorkQueueWith(
      ctx.db,
      { sources, deferrals },
      {
        input: { pageSize: 100, ...input },
        memberPartyId: null,
        memberOnly: false,
      },
    );

  it("prunes impossible sources before preparing evidence and unions admitted rows", async () => {
    const admitted = fakeSource(
      "admitted",
      [
        { key: "one", reasons: ["a"] },
        { key: "two", reasons: ["a", "b"] },
      ],
      { family: "research", executor: "agent", entity: "product" },
    );
    const family = fakeSource("family", [], { family: "account" });
    const executor = fakeSource("executor", [], {
      family: "research",
      executor: "external",
    });
    const entity = fakeSource("entity", [], {
      family: "research",
      executor: "agent",
      entity: "vendor",
    });
    const reason = {
      ...fakeSource("reason", [], { family: "research", executor: "agent" }),
      reasons: [{ key: "c", label: "Reason c" }],
    };
    const other = fakeSource("other", [{ key: "three", reasons: ["a"] }], {
      family: "research",
      executor: "agent",
      entity: "product",
    });
    const page = await read(
      [admitted, family, executor, entity, reason, other],
      { family: "research", executor: "agent", entity: "product", reason: "a" },
    );
    expect(page.meta.totalCount).toBe(0); // Declared Type also filters the resulting relation.
    for (const source of [family, executor, entity, reason])
      expect(source.candidates).not.toHaveBeenCalled();
    expect(admitted.candidates).toHaveBeenCalledOnce();
    const union = await read([admitted, other], { reason: "a" });
    expect(union.items.map((row) => row.key)).toEqual(["one", "three", "two"]);
    expect(union.meta.totalCount).toBe(3);
    const recordSource = fakeSource("record", [], { entity: "product" });
    const unrelated = fakeSource("unrelated-record", [], { entity: "vendor" });
    await readRecordWorkQueueWith(
      ctx.db,
      { sources: [recordSource, unrelated], deferrals: [] },
      { id: "PRD-AAAAA", memberPartyId: null, memberOnly: false },
    );
    expect(recordSource.candidates).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({
        record: { entity: "product", id: "PRD-AAAAA" },
      }),
    );
    expect(unrelated.candidates).not.toHaveBeenCalled();
  });

  it("filters overlapping reasons, counts views and reason actions before offset paging", async () => {
    const source = fakeSource(
      "dynamic",
      [
        {
          key: "Alpha",
          reasons: ["a", "b"],
          executor: "agent",
          amount: -5,
          date: "2026-09-01",
        },
        {
          key: "Beta",
          reasons: ["b"],
          executor: "human",
          amount: 12,
          date: "2026-09-02",
        },
        { key: "Gamma", reasons: ["c"], executor: "external" },
        { key: "Deferred", reasons: ["a"], executor: "automatic" },
      ],
      { executor: "dynamic" },
    );
    const deferrals = [sql`key = ${"Deferred"}`];
    const page = await read(
      [source],
      { reason: ["a", "b"], group: "reason", pageSize: 1, pageIndex: 1 },
      deferrals,
    );
    expect(page.items.map((row) => row.key)).toEqual(["Beta"]);
    expect(page.meta).toMatchObject({
      totalCount: 2,
      viewCounts: { all: 2, agent: 1, human: 1, external: 0, automatic: 0 },
      groups: [
        {
          key: "a",
          count: 1,
          actions: [{ id: "dynamic:repair", scope: "group" }],
        },
        {
          key: "b",
          count: 1,
          actions: [{ id: "dynamic:repair", scope: "group" }],
        },
      ],
    });
    const excluded = await read(
      [source],
      { reason: "b", reasonExclude: "a" },
      deferrals,
    );
    expect(excluded.items.map((row) => row.key)).toEqual(["Beta"]);
    const view = await read([source], { view: "agent" }, deferrals);
    expect(view.items.map((row) => row.key)).toEqual(["Alpha"]);
    expect(view.meta.viewCounts).toMatchObject({
      all: 3,
      agent: 1,
      human: 1,
      external: 1,
    });
    const sorted = await read(
      [source],
      { sort: [{ orderBy: "amount", direction: "asc" }] },
      deferrals,
    );
    expect(sorted.items.map((row) => row.amount)).toEqual([-5, 12, null]);
    expect(
      (
        await read(
          [source],
          { executorExclude: "agent", query: "Beta" },
          deferrals,
        )
      ).items.map((row) => row.key),
    ).toEqual(["Beta"]);
  });

  it("routes shared and unresolved owners, resolves @me, and fences member reads", async () => {
    const otherUser = testUserId("synthetic-work-engine-other");
    await getDb(ctx.db).insert(user).values({
      id: otherUser,
      name: "Synthetic second member",
      email: "work-engine-other@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const first = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic first member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const second = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic second member",
      kind: "member",
      userId: otherUser,
    });
    const source = fakeSource("owners", [
      { key: "mine", reasons: ["a"], owners: [first.id] },
      { key: "theirs", reasons: ["a"], owners: [second.id] },
      { key: "both", reasons: ["a"], owners: [first.id, second.id] },
      { key: "shared", reasons: ["a"], shared: true },
      { key: "unresolved", reasons: ["a"], owners: [null] },
      { key: "missing", reasons: ["a"] },
    ]);
    const composition = { sources: [source], deferrals: [] };
    const household = await read([source]);
    expect(
      household.items
        .find((row) => row.key === "shared")
        ?.owners.map((owner) => owner.id)
        .sort(),
    ).toEqual([first.shortcode, second.shortcode].sort());
    expect(
      household.items.find((row) => row.key === "unresolved")?.owners,
    ).toEqual([]);
    const input = await resolveFilterTokens(
      { db: ctx.db, actorContext: ctx.actor },
      workQueueInput,
      workQueueInput.parse({ owner: CURRENT_MEMBER_FILTER }),
    );
    expect(input.owner).toBe(first.shortcode);
    const own = await readWorkQueueWith(ctx.db, composition, {
      input,
      memberPartyId: first.id,
      memberOnly: false,
    });
    expect(own.items.map((row) => row.key)).toEqual(["both", "mine", "shared"]);
    const fenced = await readWorkQueueWith(ctx.db, composition, {
      input: { pageSize: 100 },
      memberPartyId: first.id,
      memberOnly: true,
    });
    expect(fenced.items.map((row) => row.key)).toEqual(["mine", "shared"]);
    const unlinked = await readWorkQueueWith(ctx.db, composition, {
      input: {},
      memberPartyId: null,
      memberOnly: true,
    });
    expect(unlinked.items.map((row) => row.key)).toEqual(["shared"]);
    const withoutMe = await read([source], { ownerExclude: first.shortcode });
    expect(withoutMe.items.map((row) => row.key)).toEqual([
      "missing",
      "theirs",
      "unresolved",
    ]);
  });

  // Copy a writer-created Project through the identity writer to install the reserved system anchor.
  const diagnosticAnchor = async () => {
    const created = await createRepoEntity(ctx, "project", {
      name: "Synthetic diagnostic anchor",
    });
    const [row] = await getDb(ctx.db)
      .select()
      .from(project)
      .where(eq(project.shortcode, created.output.id));
    if (!row) throw new Error("Synthetic project was not persisted");
    const { id: _id, shortcode: _shortcode, ...values } = row;
    const anchor = await insertWithShortcode(ctx.db, "project", values, {
      generate: (entity) =>
        parseShortcodeFor(entity, HOUSEHOLD_PROJECT_SHORTCODE),
    });
    return anchor.id;
  };
  const publishDiagnostics = async (
    id: string,
    value: WorkDiagnosticFacts,
    computedAt = new Date(),
  ) => {
    const parsed = workDiagnosticFacts.parse(value);
    await getDb(ctx.db).execute(sql`
      INSERT INTO "DerivedValue" ("entityId", kind, key, value, "computedAt", "decidedBy")
      VALUES (${id}::uuid, ${entitySchema.enum.project}, 'workDiagnosticFacts', ${JSON.stringify(parsed)}::jsonb,
        ${computedAt.toISOString()}::timestamp, '{"outcome":{"kind":"value"},"provenance":{"kind":"computed"}}'::jsonb)
      ON CONFLICT ("entityId", key) DO UPDATE SET value = excluded.value, "computedAt" = excluded."computedAt", "decidedBy" = excluded."decidedBy"`);
  };
  const readDiagnostics = (
    input: WorkQueueInput,
    memberPartyId: Parameters<
      typeof readWorkQueueWith
    >[2]["memberPartyId"] = null,
    memberOnly = false,
  ) =>
    readWorkQueueWith(
      ctx.db,
      { ...diagnosticWorkSources(), deferrals: [] },
      { input, memberPartyId, memberOnly },
    );

  it("retains published diagnostic counts across missing inputs, errors and day expiry without read repair", async () => {
    const anchor = await diagnosticAnchor();
    await getDb(ctx.db).execute(
      sql.raw(
        `DO $install$ BEGIN EXECUTE $ddl$${derivedTriggerDdl()}$ddl$; END $install$;`,
      ),
    );
    const before = await getDb(ctx.db).execute(
      sql`SELECT target, ref, ticket FROM "WorkItem" ORDER BY target, ref`,
    );
    const missing = await readDiagnostics({ reason: "dependencyCycles" });
    expect(missing.items).toEqual([]);
    expect(missing.meta.incompleteDiagnosticSources).toEqual([
      expect.objectContaining({
        key: "dependencyCycles",
        state: "unavailable",
      }),
    ]);
    expect(
      (
        await getDb(ctx.db).execute(
          sql`SELECT target, ref, ticket FROM "WorkItem" ORDER BY target, ref`,
        )
      ).rows,
    ).toEqual(before.rows);
    await publishDiagnostics(anchor, {
      counts: { dependencyCycles: 17, unconnectedEntities: 0 },
      privateEntries: {},
    });
    const published = await readDiagnostics({ reason: "dependencyCycles" });
    expect(published.meta.totalCount).toBe(1);
    expect(published.items[0]?.reason).toContain("17 work items.");
    const knownEmpty = await readDiagnostics({ reason: "unconnectedEntities" });
    expect(knownEmpty.items).toEqual([]);
    expect(knownEmpty.meta.incompleteDiagnosticSources).not.toContainEqual(
      expect.objectContaining({ state: "unavailable" }),
    );
    // A failed refresh preserves the last successful result and its diagnostic.
    await getDb(ctx.db)
      .execute(sql`INSERT INTO "WorkItem" (target, ref, "lastError") VALUES ('project.workDiagnosticFacts', ${anchor}::uuid, 'Synthetic refresh failure')
      ON CONFLICT (target, ref) DO UPDATE SET "lastError" = excluded."lastError"`);
    const failed = await readDiagnostics({ reason: "dependencyCycles" });
    expect(failed.items).toEqual(published.items);
    expect(failed.meta.incompleteDiagnosticSources).toEqual([
      expect.objectContaining({
        state: "stale",
        pending: true,
        error: "Synthetic refresh failure",
      }),
    ]);
    await getDb(ctx.db).execute(
      sql`DELETE FROM "WorkItem" WHERE target LIKE 'project.workDiagnosticFacts%'`,
    );
    await publishDiagnostics(
      anchor,
      { counts: { dependencyCycles: 17 }, privateEntries: {} },
      new Date("2020-01-01T12:00:00Z"),
    );
    expect(
      (await readDiagnostics({ reason: "dependencyCycles" })).meta
        .incompleteDiagnosticSources,
    ).toEqual([expect.objectContaining({ state: "stale", pending: false })]);
    // A Project without rollups must not certify a partial computation as a healthy zero.
    await expect(computeWorkDiagnosticFacts(ctx.db, [anchor])).rejects.toThrow(
      "project.rollups",
    );
    expect(
      (await loadWorkDiagnosticFacts(ctx.db))?.counts?.dependencyCycles,
    ).toBe(17);
    await getDb(ctx.db)
      .update(project)
      .set({ name: "Synthetic changed diagnostic anchor" })
      .where(eq(project.id, anchor));
    expect((await loadWorkDiagnosticFacts(ctx.db))?.pending).toBe(true);
    // The production adapter publishes only after its declared upstream roots are ready.
    await markAllStoredDerived(ctx.db);
    await drainStoredDerived(ctx.db);
    const ready = await loadWorkDiagnosticFacts(ctx.db);
    expect(ready?.counts?.dependencyCycles).toBe(0);
    expect(ready).toMatchObject({ stale: false, pending: false, error: null });
    await getDb(ctx.db).execute(
      sql`INSERT INTO "ExternalSource" (slug, label, "vendorId", issuer) VALUES ('synthetic-work-source', 'Synthetic work source', NULL, false)`,
    );
    expect((await loadWorkDiagnosticFacts(ctx.db))?.pending).toBe(true);
    await getDb(ctx.db).execute(
      sql`DELETE FROM "WorkItem" WHERE target LIKE 'project.workDiagnosticFacts%'`,
    );
    await getDb(ctx.db).execute(
      sql`UPDATE "ExternalSource" SET issuer = true WHERE slug = 'synthetic-work-source'`,
    );
    expect((await loadWorkDiagnosticFacts(ctx.db))?.pending).toBe(true);
  });

  it("pages stored private findings under current member ownership instead of private population samples", async () => {
    const anchor = await diagnosticAnchor();
    const first = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic diagnostic member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const otherUser = testUserId("synthetic-diagnostic-other");
    await getDb(ctx.db)
      .insert(user)
      .values({
        id: otherUser,
        name: "Synthetic diagnostic other",
        email: "diagnostic-other@example.test",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    const second = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic diagnostic other",
      kind: "member",
      userId: otherUser,
    });
    const own = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic own account",
      ledgerPartyId: first.shortcode,
    });
    const other = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic other account",
      ledgerPartyId: second.shortcode,
    });
    const ownRef = {
      type: "financialAccount",
      shortcode: own.output.id,
    } as const;
    const otherRef = {
      type: "financialAccount",
      shortcode: other.output.id,
    } as const;
    await publishDiagnostics(anchor, {
      counts: { invalidFinancialJson: 3 },
      privateEntries: {
        invalidFinancialJson: [
          {
            key: "private:own",
            name: "Synthetic own finding",
            reason: "Synthetic private evidence",
            refs: [ownRef],
          },
          {
            key: "private:other",
            name: "Synthetic other finding",
            reason: "Synthetic private evidence",
            refs: [otherRef],
          },
          {
            key: "private:mixed",
            name: "Synthetic mixed finding",
            reason: "Synthetic private evidence",
            refs: [ownRef, otherRef],
          },
        ],
      },
    });
    const household = await readDiagnostics({
      reason: "invalidFinancialJson",
      pageSize: 1,
      pageIndex: 1,
      sort: [{ orderBy: "name", direction: "asc" }],
    });
    expect(household.meta.totalCount).toBe(3);
    expect(household.items).toHaveLength(1);
    const member = await readDiagnostics(
      { reason: "invalidFinancialJson" },
      first.id,
      true,
    );
    expect(member.items.map((row) => row.key)).toEqual(["private:own"]);
    expect(member.meta.totalCount).toBe(1);
    const searched = await readDiagnostics({
      reason: "invalidFinancialJson",
      query: "mixed",
      group: "reason",
    });
    expect(searched.meta.totalCount).toBe(1);
    expect(searched.meta.groups?.map((group) => group.count)).toEqual([1]);
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialAccount" SET "ledgerPartyId" = (SELECT id FROM "LedgerParty" WHERE shortcode = ${second.shortcode}) WHERE shortcode = ${own.output.id}`,
    );
    expect(
      (
        await readDiagnostics(
          { reason: "invalidFinancialJson" },
          first.id,
          true,
        )
      ).items,
    ).toEqual([]);
    // A deleted reference fails closed even though its published finding remains retained.
    await getDb(ctx.db)
      .update(financialAccount)
      .set({ deletedAt: new Date() })
      .where(eq(financialAccount.shortcode, own.output.id));
    expect(
      (
        await readDiagnostics(
          { reason: "invalidFinancialJson" },
          first.id,
          true,
        )
      ).meta.totalCount,
    ).toBe(0);
  });

  it("composes real gap sources with their declared labels and fresh record facts", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic source gap widget",
        categoryId: null,
      }),
      ctx.actor,
    );
    await publishAllQualityFixtures(ctx.db);
    const queue = await readComposedQueue(ctx.db, {
      input: {
        reason: "product_category",
        query: "Synthetic source gap widget",
      },
      memberPartyId: null,
      memberOnly: false,
    });
    expect(queue.items).toEqual([
      expect.objectContaining({
        id: product.id,
        family: "research",
        executor: "agent",
        reasonKeys: expect.arrayContaining(["product_category"]),
      }),
    ]);
    expect(queue.items[0]?.gaps.map((gap) => gap.check)).toContain(
      "product_category",
    );
    const excluded = await readComposedQueue(ctx.db, {
      input: { reason: "product_category", reasonExclude: "product_category" },
      memberPartyId: null,
      memberOnly: false,
    });
    expect(excluded.meta.totalCount).toBe(0);
  });
});
