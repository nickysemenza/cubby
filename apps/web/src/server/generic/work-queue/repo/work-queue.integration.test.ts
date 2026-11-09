import { entitySchema } from "@cubby/schemas/entity-core";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project-fields";
import { testUserId } from "@cubby/schemas/testing";
import {
  workDiagnosticFacts,
  type WorkDiagnosticFacts,
} from "@cubby/schemas/work-diagnostic-facts";
import {
  NEEDS_YOU_FILTERS,
  workQueueInput,
  type WorkQueueInput,
  type WorkFamily,
  type WorkExecutor,
} from "@cubby/schemas/work-queue";
import { CURRENT_MEMBER_FILTER } from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { afterExecutionTasks, runWithExecutionCtx } from "~/server/cf-env";
import { user } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import {
  project,
  financialAccount,
  product as productTable,
} from "~/server/db/schema";
import { upsertAgentProductMatch } from "~/server/domains/product/repo/match/product-match-candidate";
import { loadWorkDiagnosticFacts } from "~/server/domains/work/repo/work-diagnostic-facts";
import {
  diagnosticWorkSources,
  computeWorkDiagnosticFacts,
} from "~/server/domains/work/service/work-diagnostics";
import {
  readPublishedWorkQueue,
  readWorkQueue as readComposedQueue,
} from "~/server/domains/work/service/work-queue-read";
import { resolveFilterTokens } from "~/server/entity-kernel/filter-tokens";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  markWorkPublicationDirty,
  readWorkPublication,
  workPublicationStale,
} from "~/server/generic/work-queue/repo/work-publication";
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
  exclusiveOwner?: string | null;
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
        exclusiveOwner: sql`fixture."exclusiveOwner"`,
        shared: sql`fixture.shared`,
        amount: sql`fixture.amount`,
        date: sql`fixture.date`,
      }).from(
        sql`jsonb_to_recordset(${JSON.stringify(rows.map((row) => ({ name: row.key, owners: [], shared: false, amount: null, date: null, ...row })))}::jsonb) AS fixture(key text, name text, reasons text[], owners uuid[], "exclusiveOwner" uuid, shared boolean, executor text, amount double precision, date date)`,
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
          reasons: ["a", "b", "b", "c"],
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
    // Summary-only counts cover the same population before paging. A row
    // carrying two reasons belongs in both cells, but only once in margins.
    const summary = await read(
      [source],
      { reason: ["a", "b"], pageSize: 0 },
      deferrals,
    );
    expect(summary.items).toEqual([]);
    expect(summary.meta).toMatchObject({
      totalCount: 2,
      summary: {
        cells: [
          { reason: "a", entity: null, count: 1 },
          { reason: "b", entity: null, count: 2 },
        ],
        types: [{ entity: null, count: 2 }],
      },
    });
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
    expect(
      (
        await read(
          [source],
          { reason: "b", reasonExclude: "a", pageSize: 0 },
          deferrals,
        )
      ).meta.summary?.cells,
    ).toEqual([{ reason: "b", entity: null, count: 1 }]);
    const view = await read([source], { view: "agent" }, deferrals);
    expect(view.items.map((row) => row.key)).toEqual(["Alpha"]);
    expect(
      (await read([source], { view: "agent", pageSize: 0 }, deferrals)).meta
        .summary,
    ).toEqual({
      cells: [
        { reason: "a", entity: null, count: 1 },
        { reason: "b", entity: null, count: 1 },
        { reason: "c", entity: null, count: 1 },
      ],
      types: [{ entity: null, count: 1 }],
    });
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
    const base = fakeSource("owners", [
      {
        key: "mine",
        reasons: ["a"],
        owners: [first.id],
        exclusiveOwner: first.id,
      },
      {
        key: "theirs",
        reasons: ["a"],
        owners: [second.id],
        exclusiveOwner: second.id,
      },
      { key: "both", reasons: ["a"], owners: [first.id, second.id] },
      {
        key: "shared",
        reasons: ["a"],
        shared: true,
        exclusiveOwner: second.id,
      },
      {
        key: "unresolved",
        reasons: ["a"],
        owners: [null],
        exclusiveOwner: second.id,
      },
      { key: "missing", reasons: ["a"] },
    ]);
    const source: WorkSource = {
      ...base,
      inputLabel: "Synthetic source checks",
      candidates: async (db, scope) => {
        const candidates = await base.candidates(db, scope);
        return candidates && { ...candidates, missingInputs: candidates.query };
      },
    };
    const composition = { sources: [source], deferrals: [] };
    const household = await read([source]);
    expect(household.meta.totalCount).toBe(6);
    expect(household.meta.incompleteSources).toEqual([
      { source: "owners", label: "Synthetic source checks", count: 6 },
    ]);
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
    expect(own.meta.incompleteSources?.[0]?.count).toBe(3);
    const ownSummary = await readWorkQueueWith(ctx.db, composition, {
      input: { ...input, pageSize: 0 },
      memberPartyId: first.id,
      memberOnly: false,
    });
    expect(ownSummary.meta).toMatchObject({
      totalCount: 3,
      summary: {
        cells: [{ reason: "a", entity: null, count: 3 }],
        types: [{ entity: null, count: 3 }],
      },
      incompleteSources: own.meta.incompleteSources,
    });
    const noValue = await read([source], {
      owner: first.shortcode,
      ownerPresence: "none",
    });
    expect(noValue.items.map((row) => row.key)).toEqual([
      "both",
      "mine",
      "missing",
      "shared",
      "unresolved",
    ]);
    expect(noValue.meta.totalCount).toBe(5);
    expect(noValue.meta.viewCounts).toMatchObject({ all: 5, human: 5 });
    const anyValue = await read([source], {
      owner: first.shortcode,
      ownerPresence: "has",
    });
    expect(anyValue.items.map((row) => row.key)).toEqual([
      "both",
      "mine",
      "shared",
      "theirs",
    ]);
    expect(anyValue.meta.totalCount).toBe(4);
    expect(anyValue.meta.viewCounts).toMatchObject({ all: 4, human: 4 });
    expect(
      (
        await read([source], { owner: [first.shortcode, second.shortcode] })
      ).items.map((row) => row.key),
    ).toEqual(anyValue.items.map((row) => row.key));
    const fenced = await readWorkQueueWith(ctx.db, composition, {
      input: { pageSize: 100 },
      memberPartyId: first.id,
      memberOnly: true,
    });
    expect(fenced.items.map((row) => row.key)).toEqual(["mine", "shared"]);
    expect(fenced.meta.incompleteSources?.[0]?.count).toBe(2);
    const fencedSummary = await readWorkQueueWith(ctx.db, composition, {
      input: { pageSize: 0 },
      memberPartyId: first.id,
      memberOnly: true,
    });
    expect(fencedSummary.meta).toMatchObject({
      totalCount: 2,
      summary: {
        cells: [{ reason: "a", entity: null, count: 2 }],
        types: [{ entity: null, count: 2 }],
      },
      incompleteSources: fenced.meta.incompleteSources,
    });
    const unlinked = await readWorkQueueWith(ctx.db, composition, {
      input: {},
      memberPartyId: null,
      memberOnly: true,
    });
    expect(unlinked.items.map((row) => row.key)).toEqual(["shared"]);
    expect(unlinked.meta.incompleteSources?.[0]?.count).toBe(1);
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
      INSERT INTO "ProjectReadSnapshot" ("entityId", kind, "workDiagnosticFacts", "workDiagnosticFactsComputedAt", "workDiagnosticFactsDecision")
      VALUES (${id}::uuid, ${entitySchema.enum.project}, ${JSON.stringify(parsed)}::jsonb,
        ${computedAt.toISOString()}::timestamp, '{"outcome":{"kind":"value"},"provenance":{"kind":"computed"}}'::jsonb)
      ON CONFLICT ("entityId") DO UPDATE SET "workDiagnosticFacts" = excluded."workDiagnosticFacts", "workDiagnosticFactsComputedAt" = excluded."workDiagnosticFactsComputedAt", "workDiagnosticFactsDecision" = excluded."workDiagnosticFactsDecision"`);
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

  it("retains published diagnostic counts across missing inputs without read repair", async () => {
    const anchor = await diagnosticAnchor();
    const missing = await readDiagnostics({ reason: "dependencyCycles" });
    expect(missing.items).toEqual([]);
    expect(missing.meta.incompleteDiagnosticSources).toEqual([
      expect.objectContaining({
        key: "dependencyCycles",
        state: "unavailable",
      }),
    ]);
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
    // Retained tickets no longer report per-value freshness; the coarse pass owns failures.
    // A Project created mid-pass leaves that source unavailable without failing the pass.
    const partial = await computeWorkDiagnosticFacts(ctx.db, [anchor]);
    const facts = workDiagnosticFacts.parse(partial.get(anchor)?.value);
    expect(facts.counts).not.toHaveProperty("projectsWithDateDrift");
    expect(facts.counts.dependencyCycles).toBe(0);
    expect(
      (await loadWorkDiagnosticFacts(ctx.db))?.counts?.dependencyCycles,
    ).toBe(17);
    await getDb(ctx.db)
      .update(project)
      .set({ name: "Synthetic changed diagnostic anchor" })
      .where(eq(project.id, anchor));
    expect((await loadWorkDiagnosticFacts(ctx.db))?.pending).toBe(false);
    // The next pass converges after its upstream roots publish.
    await drainStoredDerived(ctx.db);
    const ready = await loadWorkDiagnosticFacts(ctx.db);
    expect(ready?.counts?.dependencyCycles).toBe(0);
    expect(ready).toMatchObject({ stale: false, pending: false, error: null });
    await getDb(ctx.db).execute(
      sql`INSERT INTO "ExternalSource" (slug, label, "vendorId", issuer) VALUES ('synthetic-work-source', 'Synthetic work source', NULL, false)`,
    );
    expect((await loadWorkDiagnosticFacts(ctx.db))?.pending).toBe(false);
    await getDb(ctx.db).execute(
      sql`UPDATE "ExternalSource" SET issuer = true WHERE slug = 'synthetic-work-source'`,
    );
    expect((await loadWorkDiagnosticFacts(ctx.db))?.pending).toBe(false);
  });

  it("pages stored private findings under current member ownership instead of private population samples", async () => {
    const anchor = await diagnosticAnchor();
    const first = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic diagnostic member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const otherUser = testUserId("synthetic-diagnostic-other");
    await getDb(ctx.db).insert(user).values({
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

  // Regression: a failed first publication left WorkItem empty and the read
  // served it as a complete zero; a failing republish served old rows silently.
  it("fails a cold read, then keeps the last good rows with a failed republish's raw error", async () => {
    const execute = (statement: ReturnType<typeof sql>) =>
      getDb(ctx.db).execute(statement);
    const lamp = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic publication failure lamp" }),
      ctx.actor,
    );
    await seedFieldSuggestion(ctx.db, {
      entity: "product",
      recordId: lamp.entityId,
      field: "model",
      currentValue: null,
      suggestedValue: "Synthetic model",
      confidence: 0.9,
      model: "typesafe/jev",
      kind: "addition",
      status: "pending",
      createdAt: new Date(),
    });
    await execute(sql`
      CREATE FUNCTION synthetic_work_item_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic publication failure'; END $$`);
    const failInserts = () =>
      execute(sql`
        CREATE TRIGGER synthetic_work_item_failure BEFORE INSERT ON "WorkItem"
        FOR EACH STATEMENT EXECUTE FUNCTION synthetic_work_item_failure()`);
    await failInserts();
    const read = {
      input: {
        reason: "suggestions:field",
        query: "Synthetic publication failure lamp",
      },
      memberPartyId: null,
      memberOnly: false,
    } as const;
    try {
      await expect(readPublishedWorkQueue(ctx.db, read)).rejects.toThrow(
        /not published yet; the last attempt failed: .*synthetic publication failure/,
      );
      const failed = await readWorkPublication(ctx.db);
      expect(failed).toMatchObject({ publishedAt: null, meta: null });
      expect(failed?.attemptedAt).toBeInstanceOf(Date);
      // Within the backoff the next read reports the same attempt.
      await expect(readPublishedWorkQueue(ctx.db, read)).rejects.toThrow(
        /synthetic publication failure/,
      );
      expect((await readWorkPublication(ctx.db))?.attemptedAt).toEqual(
        failed?.attemptedAt,
      );

      await execute(
        sql`DROP TRIGGER synthetic_work_item_failure ON "WorkItem"`,
      );
      await execute(
        sql`UPDATE "WorkPublication" SET "attemptedAt" = "attemptedAt" - interval '2 minutes'`,
      );
      const good = await readPublishedWorkQueue(ctx.db, read);
      expect(good.items.map((row) => row.id)).toEqual([lamp.id]);
      expect(good.meta.publication).toEqual({
        publishedAt: expect.any(String),
        error: null,
      });
      expect(await readWorkPublication(ctx.db)).toMatchObject({
        error: null,
        attemptedAt: null,
      });

      // Republishing keeps failing: reads serve the last good rows and say so.
      await failInserts();
      await getDb(ctx.db)
        .update(productTable)
        .set({ deletedAt: new Date() })
        .where(eq(productTable.shortcode, lamp.id));
      await markWorkPublicationDirty(ctx.db);
      await readPublishedWorkQueue(ctx.db, read);
      const stale = await readPublishedWorkQueue(ctx.db, read);
      expect(stale.items.map((row) => row.key)).toEqual(
        good.items.map((row) => row.key),
      );
      expect(stale.meta.totalCount).toBe(1);
      expect(stale.meta.publication).toEqual({
        publishedAt: good.meta.publication?.publishedAt,
        error: expect.stringMatching(/synthetic publication failure/),
      });
    } finally {
      // The file shares one database; later cases start from no publication.
      await execute(
        sql`DROP TRIGGER IF EXISTS synthetic_work_item_failure ON "WorkItem"`,
      );
      await execute(sql`DROP FUNCTION synthetic_work_item_failure()`);
      await execute(sql`DELETE FROM "WorkPublication"`);
      await execute(sql`DELETE FROM "WorkItem"`);
    }
  });

  // Regression: the publication stored one record's pending families together,
  // so excluding one family (Needs you excludes field suggestions) dropped a
  // Product that also had a product-pair review.
  it("keeps a mixed suggestion record's admitted families in the publication", async () => {
    const [lamp, partner] = await Promise.all(
      ["Synthetic mixed suggestion lamp", "Synthetic pair partner lamp"].map(
        (name) =>
          createProductIdentityFixture(
            ctx.db,
            makeProductInput({ name }),
            ctx.actor,
          ),
      ),
    );
    if (!lamp || !partner)
      throw new Error("Synthetic products were not created");
    await seedFieldSuggestion(ctx.db, {
      entity: "product",
      recordId: lamp.entityId,
      field: "model",
      currentValue: null,
      suggestedValue: "Synthetic model",
      confidence: 0.9,
      model: "typesafe/jev",
      kind: "addition",
      status: "pending",
      createdAt: new Date(),
    });
    await upsertAgentProductMatch(ctx.db, {
      productIds: [lamp.entityId, partner.entityId],
      evidence: "Synthetic same lamp",
      sourceUrls: [],
    });
    const both = ["suggestions:field", "suggestions:product_pair"];
    for (const [filters, reasonKeys] of [
      [
        { reasonExclude: NEEDS_YOU_FILTERS.reasonExclude },
        ["suggestions:product_pair"],
      ],
      [{ reason: "suggestions:field" }, ["suggestions:field"]],
      [{ reason: both }, both],
      [{}, both],
    ] as const) {
      const read = {
        input: {
          ...filters,
          entity: "product",
          query: "Synthetic mixed suggestion",
        },
        memberPartyId: null,
        memberOnly: false,
      } as const;
      const live = await readComposedQueue(ctx.db, read);
      expect(
        live.items.filter((row) => row.family === "suggestion"),
      ).toMatchObject([{ id: lamp.id, reasonKeys }]);
      const published = await readPublishedWorkQueue(ctx.db, read);
      expect(published.items).toEqual(live.items);
      expect(published.meta.totalCount).toBe(live.meta.totalCount);
    }
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
    const readResearch = () =>
      readComposedQueue(ctx.db, {
        input: {
          reason: "product_category",
          query: "Synthetic source gap widget",
        },
        memberPartyId: null,
        memberOnly: false,
      });
    const unpublished = await readResearch();
    expect(unpublished.meta.totalCount).toBe(0);
    expect(unpublished.meta.incompleteSources).toEqual([
      {
        source: "research:product",
        label: "Product quality checks",
        count: 1,
      },
    ]);
    const human = await readComposedQueue(ctx.db, {
      input: {
        view: "human",
        reason: "product_category",
        query: "Synthetic source gap widget",
      },
      memberPartyId: null,
      memberOnly: false,
    });
    expect(human.meta.incompleteSources).toEqual([]);
    const agent = await readComposedQueue(ctx.db, {
      input: {
        view: "agent",
        reason: "product_category",
        query: "Synthetic source gap widget",
      },
      memberPartyId: null,
      memberOnly: false,
    });
    expect(agent.meta.incompleteSources).toEqual(
      unpublished.meta.incompleteSources,
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
    expect(queue.meta.incompleteSources).toEqual([]);
    // The household web's publication reads the same rows, counts and gaps.
    const published = await readPublishedWorkQueue(ctx.db, {
      input: {
        reason: "product_category",
        query: "Synthetic source gap widget",
      },
      memberPartyId: null,
      memberOnly: false,
    });
    expect(published.items).toEqual(queue.items);
    expect(published.meta.totalCount).toBe(queue.meta.totalCount);

    // A member write leaves the rows readable and republishes after the
    // response as a tracked waitUntil task: withRequestDb's pool close
    // (afterExecutionTasks) runs only once the new rows are published.
    await getDb(ctx.db)
      .update(productTable)
      .set({ deletedAt: new Date() })
      .where(eq(productTable.shortcode, product.id));
    await markWorkPublicationDirty(ctx.db);
    const read = {
      input: {
        reason: "product_category",
        query: "Synthetic source gap widget",
      },
      memberPartyId: null,
      memberOnly: false,
    } as const;
    const tasks: Promise<unknown>[] = [];
    let freshAtPoolClose: boolean | undefined;
    const stale = await runWithExecutionCtx(
      { waitUntil: (task) => void tasks.push(task) },
      async () => {
        const result = await readPublishedWorkQueue(ctx.db, read);
        afterExecutionTasks(Promise.resolve(), async () => {
          freshAtPoolClose = !workPublicationStale(
            await readWorkPublication(ctx.db),
          );
        });
        return result;
      },
    );
    expect(stale.items.map((row) => row.id)).toEqual([product.id]);
    await Promise.all(tasks);
    expect(freshAtPoolClose).toBe(true);
    expect((await readPublishedWorkQueue(ctx.db, read)).meta.totalCount).toBe(
      0,
    );
    const excluded = await readComposedQueue(ctx.db, {
      input: { reason: "product_category", reasonExclude: "product_category" },
      memberPartyId: null,
      memberOnly: false,
    });
    expect(excluded.meta.totalCount).toBe(0);
  });
});
