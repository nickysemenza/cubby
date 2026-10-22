import { assessmentPublication } from "@cubby/schemas/assessment";
import { dataCheckMessage } from "@cubby/schemas/data-quality";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { testUserId } from "@cubby/schemas/testing";
import {
  workQueueHouseholdInput,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { householdLocalDate, shiftPlainDate } from "~/lib/household-date";
import { user } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { assessment, expense, run } from "~/server/db/schema";
import * as connections from "~/server/domains/connection/repo/entity-connections";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  publishAssessment,
  publishFieldAssessment,
} from "~/server/generic/assessment/repo/assessment";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/generic/work-queue/service/work-queue-read";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { seedRunFinding } from "~/server/testing/run-finding.fixtures";

// Failure modes: a check filter applied after paging leaves counts and pages
// that disagree with the rows; a branch that cannot carry the check leaks into
// a check-filtered page; gap rows lose their check ids to joined prose; typed
// sorts order nulls or negatives inconsistently across directions; a record
// strip shows another record's work, a field-wide suggestion group, or work a
// member-only read would fence; future purchases leak through reconciliation
// or findings, inflate counts, or hide incurred work in a mixed purchase.
// Overlapping diagnostic reads must retain complete diagnostic rows, source
// filters and member routing; one failed diagnostic must fail the whole read.
// Shared price evidence must preserve explicit/zero prices, inherited kit
// prices and exception fingerprints; unrelated check reads must not require it.
// Entity predicates and diagnostics may overlap, but must preserve scoped
// results, declaration order and the one shared Project-attention snapshot.
// A grouped read whose sections disagree with its page order misfiles rows.
describe("Work queue gaps, typed columns, and record rows", () => {
  const ctx = withTestDb();

  // Listing must not reconstruct every pending connection's evidence before
  // pagination. Background retirement owns display freshness; apply still fences it.
  it("lists stored pending connections without synchronous freshness reconstruction", async () => {
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic queue connection" }),
      ctx.actor,
    );
    const line = await createRepoEntity(ctx, "expense", {
      name: "Synthetic connection charge",
      trade: "electrical",
      costType: "tools",
      cost: 20,
    });
    const proposal = await connections.publishEntityConnection(ctx.db, {
      relation: "product-expense",
      source: { entityKind: "product", entityId: item.id },
      target: { entityKind: "expense", entityId: line.output.id },
      label: "Synthetic acquisition",
      evidence: { reasons: [], contradictions: [], unknowns: [] },
    });
    const [original] = await getDb(ctx.db)
      .select()
      .from(assessment)
      .where(eq(assessment.id, proposal.review.assessmentId));
    if (!original) throw new Error("Synthetic connection assessment missing");
    // Removing read-time reconstruction must retain the served-only gate:
    // an unserved trial is not household work, even with identical evidence.
    await publishAssessment(
      ctx.db,
      assessmentPublication.parse({
        ...original,
        publicationKey: "synthetic-unserved-queue-trial",
        served: false,
      }),
    );
    await publishAssessment(
      ctx.db,
      {
        publicationKey: "synthetic-inactive-guarded-field",
        family: "field",
        subject: {
          kind: "field",
          entity: "expense",
          recordId: line.entityId,
          field: "productId",
        },
        judgment: { value: item.id },
        fingerprint: "synthetic-inactive-field",
        producer: null,
        evidence: {},
      },
      {
        active: false,
        suggestedValue: item.id,
        data: { connectionEvidence: original.evidence },
      },
    );
    const expensive = vi
      .spyOn(connections, "readEntityConnectionsBatch")
      .mockRejectedValue(
        new Error("Synthetic full-population evidence rebuild"),
      );
    try {
      const page = await readWorkQueue(
        ctx.db,
        null,
        workQueueHouseholdInput.parse({ source: "suggestion", pageSize: 1 }),
        false,
      );
      expect(page.items).toContainEqual(
        expect.objectContaining({
          key: "suggestions:recommendation",
          reason: "1 pending connection suggestion",
        }),
      );
      expect(expensive).not.toHaveBeenCalled();
      expect(page.meta.totalCount).toBe(1);
    } finally {
      expensive.mockRestore();
    }
  });

  const merchandiseOrder = async (prefix: string) => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `${prefix} vendor`,
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `${prefix} merchandise`,
      productExpectation: "required",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      displayLabel: `${prefix} order`,
      spendingCategoryId: category.id,
      date: "2026-09-20",
    });
    const lines = [];
    for (const [name, cost, date] of [
      ["Refund", -5, "2026-09-18"],
      ["Line", 20, "2026-09-21"],
      ["Unpriced", null, null],
    ] as const)
      lines.push(
        await insertWithShortcode(ctx.db, "expense", {
          name: `${prefix} ${name}`,
          purchaseId: purchase.id,
          cost,
          date,
          costType: "materials",
          trade: "other",
          lineKind: "principal",
          lineBasis: "item_line",
          economicRole: "vendor",
        }),
      );
    return { vendor, purchase, lines };
  };

  const read = (input: z.input<typeof workQueueHouseholdInput>) =>
    readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({ pageSize: 100, ...input }),
      false,
    );
  const names = (rows: WorkQueueRow[]) => rows.map((row) => row.name);

  // A running interactive handoff has no scheduled executor. Its status alone
  // must not advertise automatic work or inflate that view's count.
  it("requires scheduled execution before projecting a running Run as automatic", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic scheduled execution member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const manual = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      {
        purpose: "photo_inventory",
        trigger: "manual",
        status: "running",
      },
    );
    const scheduled = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      {
        purpose: "ai_refresh",
        trigger: "manual",
        status: "running",
      },
    );
    const page = await read({ view: "automatic" });
    const [manualRecord] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, manual));
    const [scheduledRecord] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, scheduled));
    if (!manualRecord || !scheduledRecord)
      throw new Error("Synthetic execution Runs missing");
    expect(page.items.some((row) => row.id === manualRecord.shortcode)).toBe(
      false,
    );
    expect(
      page.items.some(
        (row) =>
          row.id === scheduledRecord.shortcode && row.source === "execution",
      ),
    ).toBe(true);
    await getDb(ctx.db)
      .update(run)
      .set({ dispatchEventId: "synthetic-photo-dispatch" })
      .where(eq(run.id, manual));
    const dispatched = await read({ view: "automatic" });
    expect(
      dispatched.items.some(
        (row) =>
          row.id === manualRecord.shortcode && row.source === "execution",
      ),
    ).toBe(true);
  });

  // A view applied after LIMIT would return an empty research page/count
  // when independent reconciliation or diagnostic rows sort before it.
  it("selects shared work views before counts and pagination", async () => {
    const prefix = "Synthetic shared view";
    await merchandiseOrder(prefix);
    const page = await read({ query: prefix, view: "research", pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.meta.totalCount).toBeGreaterThan(1);
    expect(page.items[0]?.kind).toBe("research");
    expect(page.items[0]?.explanations.length).toBeGreaterThan(0);
    const record = page.items[0]?.id;
    if (!record) throw new Error("Research row has no record");
    const strip = await readRecordWorkQueue(ctx.db, null, record, false);
    expect(
      strip.items.find((row) => row.key === page.items[0]?.key)?.explanations,
    ).toEqual(page.items[0]?.explanations);
    const automatic = await read({ query: prefix, view: "automatic" });
    expect(automatic.items).toEqual([]);
    expect(automatic.meta.totalCount).toBe(0);
    const review = await read({ query: prefix, view: "review" });
    const all = await read({ query: prefix });
    const waiting = await read({ query: prefix, view: "waiting" });
    expect(page.meta).toMatchObject({
      viewCounts: {
        all: all.meta.totalCount,
        research: page.meta.totalCount,
        automatic: automatic.meta.totalCount,
        review: review.meta.totalCount,
        waiting: waiting.meta.totalCount,
      },
    });
    // Sections sort ahead of the requested order, so loaded rows are a prefix
    // of the summary and its counts cover the whole filtered set.
    const grouped = await read({
      query: prefix,
      group: "recordType",
      sort: [{ orderBy: "amount", direction: "desc" }],
    });
    const sections = grouped.meta.groups ?? [];
    expect(sections.length).toBeGreaterThan(1);
    expect(
      grouped.items.map((row) =>
        row.entity ? entitySummary[row.entity].singular : "Problem",
      ),
    ).toEqual(
      sections.flatMap((section) => Array(section.count).fill(section.label)),
    );
    const recordType = grouped.items[0]?.entity;
    if (!recordType) throw new Error("Grouped page has no record row");
    const typed = await read({ query: prefix, entity: recordType });
    expect(typed.meta.totalCount).toBe(sections[0]?.count);
    expect(typed.items.every((row) => row.entity === recordType)).toBe(true);
    const bySource = await read({ query: prefix, group: "source" });
    const sourceSection = bySource.meta.groups?.[0];
    const source = workQueueHouseholdInput.shape.source.parse(
      sourceSection?.key,
    );
    const sourceRows = await read({ query: prefix, source });
    expect(sourceRows.meta.totalCount).toBe(sourceSection?.count);
    expect(sourceRows.items.every((row) => row.source === source)).toBe(true);
    expect(review.items.some((row) => row.source === "reconciliation")).toBe(
      true,
    );
    expect(
      review.items.every((row) =>
        row.explanations.some((action) => action.executor === "human"),
      ),
    ).toBe(true);
  });

  it("excludes future purchases across sources before counts and paging", async () => {
    const prefix = "Synthetic future queue";
    const today = householdLocalDate(new Date());
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: prefix,
    });
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: `${prefix} member`,
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runId = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      { purpose: "ai_suggest" },
    );
    type PurchaseCode = Awaited<
      ReturnType<typeof merchandiseOrder>
    >["purchase"]["shortcode"];
    const hidden: PurchaseCode[] = [];
    const visible: PurchaseCode[] = [];
    for (const scenario of [
      {
        name: "Tomorrow",
        date: shiftPlainDate(today, 1),
        lines: [false],
        hidden: true,
      },
      { name: "Planned", date: today, lines: [true], hidden: true },
      { name: "Deleted incurred", date: null, lines: [true], hidden: true },
      { name: "Today", date: today, lines: [false], hidden: false },
      { name: "Mixed", date: today, lines: [true, false], hidden: false },
      { name: "Unknown", date: null, lines: [], hidden: false },
    ]) {
      const order = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        displayLabel: `${prefix} ${scenario.name}`,
        date: scenario.date,
      });
      for (const future of scenario.lines)
        await insertWithShortcode(ctx.db, "expense", {
          name: `${prefix} line`,
          purchaseId: order.id,
          cost: 20,
          date: today,
          future,
          costType: "materials",
          lineKind: "principal",
          lineBasis: "item_line",
          economicRole: "vendor",
        });
      if (scenario.name === "Deleted incurred")
        await insertWithShortcode(ctx.db, "expense", {
          name: `${prefix} deleted line`,
          purchaseId: order.id,
          cost: 20,
          date: today,
          future: false,
          deletedAt: new Date(),
          costType: "materials",
          lineKind: "principal",
          lineBasis: "item_line",
          economicRole: "vendor",
        });
      await seedRunFinding(ctx.db, {
        runId,
        ledgerPartyId: member.id,
        entityId: order.id,
        entityKind: "purchase",
        kind: "other",
        summary: `${prefix} ${scenario.name}`,
        evidenceFingerprint: `synthetic-future-${scenario.name}`,
      });
      (scenario.hidden ? hidden : visible).push(order.shortcode);
    }
    const findings = await read({
      query: prefix,
      source: "finding",
      pageSize: 1,
    });
    expect(findings.meta.totalCount).toBe(visible.length);
    expect(findings.items).toHaveLength(1);
    expect(visible).toContain(findings.items[0]?.id);
    const all = await read({ query: prefix });
    expect(
      all.items.filter(
        (row) =>
          row.entity === "purchase" && hidden.some((code) => code === row.id),
      ),
    ).toEqual([]);
    expect(
      (await read({ query: prefix, source: "finding" })).items
        .map((row) => row.id)
        .sort(),
    ).toEqual(visible.sort());
    for (const code of hidden) {
      const strip = await readRecordWorkQueue(ctx.db, null, code, false);
      expect(strip.items).toEqual([]);
      expect(strip.meta.totalCount).toBe(0);
    }
  });

  it("filters by check before counting and paging, and carries check ids", async () => {
    const prefix = "Synthetic check filter";
    await merchandiseOrder(prefix);
    await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: `${prefix} widget`, categoryId: null }),
      ctx.actor,
    );
    const all = await read({ query: prefix });
    expect(all.meta.totalCount).toBeGreaterThanOrEqual(4);

    const lines = await read({
      query: prefix,
      check: "expense_product_resolution",
    });
    expect(lines.meta.totalCount).toBe(3);
    for (const row of lines.items) {
      expect(row).toMatchObject({ entity: "expense", source: "research" });
      expect(row.gaps.map((gap) => gap.check)).toEqual([
        "expense_product_resolution",
      ]);
      expect(row.reason).toBe(row.gaps[0]?.message);
    }
    const page = await read({
      query: prefix,
      check: ["expense_product_resolution"],
      pageSize: 1,
    });
    expect(page.meta.totalCount).toBe(3);
    expect(page.items).toHaveLength(1);

    const product = await read({ query: prefix, check: ["product_category"] });
    expect(product.meta.totalCount).toBe(1);
    expect(product.items[0]).toMatchObject({
      entity: "product",
      source: "research",
    });
    const checks = product.items[0]?.gaps.map((gap) => gap.check) ?? [];
    expect(checks).toContain("product_category");
    // Several gaps read as sentences, never the old "; " join.
    expect(product.items[0]?.reason).not.toContain(".;");
    expect(product.items[0]?.reason).toBe(
      product.items[0]?.gaps.map((gap) => gap.message).join(" "),
    );
    // Regression: search matched the projection's generic "Research queue"
    // reason, not the gap text the row displays.
    const byGapText = await read({
      query: dataCheckMessage.product_category.slice(0, 24),
    });
    expect(byGapText.items.map((row) => row.name)).toContain(
      `${prefix} widget`,
    );
    const byGenericReason = await read({
      query: "Research queue",
      check: ["product_category"],
    });
    expect(byGenericReason.meta.totalCount).toBe(0);
    // A scored source record's own score rides on its row, so the table can
    // show it; a row without a scored record carries none.
    expect(product.items[0]?.dataQuality).toMatchObject({
      score: expect.any(Number),
    });
    expect(
      all.items.filter((row) => row.entity === null && row.dataQuality),
    ).toEqual([]);
    // Non-gap rows carry no checks.
    expect(
      all.items
        .filter((row) => row.source !== "research" && row.source !== "email")
        .flatMap((row) => row.gaps),
    ).toEqual([]);
  });

  it("sorts amount and date server-side with nulls last and keeps negatives", async () => {
    const prefix = "Synthetic typed sort";
    const { vendor, purchase } = await merchandiseOrder(prefix);
    const other = await merchandiseOrder("Synthetic other vendor sort");
    const base = {
      query: "Synthetic",
      check: "expense_product_resolution" as const,
    };
    const sorted = (orderBy: "amount" | "date", direction: "asc" | "desc") =>
      read({
        ...base,
        vendor: vendor.shortcode,
        sort: [{ orderBy, direction }],
      });

    expect(names((await sorted("amount", "asc")).items)).toEqual([
      `${prefix} Refund`,
      `${prefix} Line`,
      `${prefix} Unpriced`,
    ]);
    expect(names((await sorted("amount", "desc")).items)).toEqual([
      `${prefix} Line`,
      `${prefix} Refund`,
      `${prefix} Unpriced`,
    ]);
    expect(names((await sorted("date", "asc")).items)).toEqual([
      `${prefix} Refund`,
      `${prefix} Line`,
      `${prefix} Unpriced`,
    ]);
    expect(names((await sorted("date", "desc")).items)).toEqual([
      `${prefix} Line`,
      `${prefix} Refund`,
      `${prefix} Unpriced`,
    ]);
    const rows = (await sorted("amount", "asc")).items;
    expect(rows.map((row) => [row.amount, row.date])).toEqual([
      [-5, "2026-09-18"],
      [20, "2026-09-21"],
      [null, null],
    ]);
    for (const row of rows)
      expect(row.vendor).toEqual({ id: vendor.shortcode, name: vendor.name });
    // The vendor filter applies before counting.
    const both = await read(base);
    expect(both.meta.totalCount).toBeGreaterThanOrEqual(6);
    expect(
      both.items.some((row) => row.vendor?.id === other.vendor.shortcode),
    ).toBe(true);
    // A Purchase's amount is SUM(Expense.cost); its date is its own. A finding
    // naming the Purchase carries the same facts.
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic typed sort member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runId = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      { purpose: "ai_suggest" },
    );
    await seedRunFinding(ctx.db, {
      runId,
      ledgerPartyId: member.id,
      entityId: purchase.id,
      entityKind: "purchase",
      kind: "other",
      summary: "Synthetic typed sort finding.",
      evidenceFingerprint: "synthetic-typed-sort-finding",
    });
    const strip = await readRecordWorkQueue(
      ctx.db,
      null,
      purchase.shortcode,
      false,
    );
    expect(strip.items.length).toBeGreaterThan(0);
    for (const row of strip.items)
      expect(row).toMatchObject({
        amount: 15,
        date: "2026-09-20",
        vendor: { id: vendor.shortcode, name: vendor.name },
      });
  });

  // Failure modes: page-first hydration changes full-population totals or
  // signed/null facts; equal sort values cross page boundaries nondeterministically;
  // a materialized relation accidentally survives the next request's writes.
  it("keeps tied page boundaries and live facts fresh across requests", async () => {
    const prefix = "Synthetic fresh queue pages";
    const { lines, purchase } = await merchandiseOrder(prefix);
    await getDb(ctx.db)
      .update(expense)
      .set({ name: prefix })
      .where(eq(expense.purchaseId, purchase.id));
    const filters = {
      query: prefix,
      check: "expense_product_resolution" as const,
      sort: [{ orderBy: "name" as const, direction: "asc" as const }],
    };
    const whole = await read(filters);
    expect(whole.meta.totalCount).toBe(3);
    expect(whole.items.map((row) => row.key)).toEqual(
      whole.items.map((row) => row.key).sort(),
    );
    const pages = [];
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const page = await read({ ...filters, pageSize: 1, pageIndex });
      expect(page.meta.totalCount).toBe(3);
      pages.push(...page.items);
    }
    expect(pages).toEqual(whole.items);
    expect(pages.map((row) => row.amount).sort()).toEqual([-5, 20, null]);
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: -12 })
      .where(eq(expense.id, lines[1]!.id));
    await getDb(ctx.db)
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(eq(expense.id, lines[2]!.id));
    const refreshed = await read({
      ...filters,
      pageSize: 1,
      sort: [{ orderBy: "amount", direction: "asc" }],
    });
    expect(refreshed.meta.totalCount).toBe(2);
    expect(refreshed.items).toHaveLength(1);
    expect(refreshed.items[0]).toMatchObject({
      id: lines[1]!.shortcode,
      amount: -12,
    });
  });

  // A Project record read scopes the attention rules to that project rather
  // than computing them household-wide, and still finds its attention rows.
  it("reads a Project's attention rows scoped to that project", async () => {
    const name = "Synthetic attention project";
    const project = await insertWithShortcode(ctx.db, "project", {
      name,
      status: "in_progress",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: `${name} spend`,
      projectId: project.id,
      cost: 40,
      date: "2026-09-20",
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "allocation",
      economicRole: "vendor",
    });
    const queue = await read({ query: name, pageSize: 100 });
    const projectKeys = queue.items
      .filter((row) => row.entity === "project")
      .map((row) => row.key);
    expect(projectKeys.length).toBeGreaterThan(0);
    const strip = await readRecordWorkQueue(
      ctx.db,
      null,
      project.shortcode,
      false,
    );
    expect(strip.items.map((row) => row.key).sort()).toEqual(
      [...projectKeys].sort(),
    );
  });

  it("reads one record's rows without suggestion groups or fenced work", async () => {
    const prefix = "Synthetic record strip";
    const { lines } = await merchandiseOrder(prefix);
    const [refund, line] = lines;
    if (!refund || !line) throw new Error("fixture lines missing");
    const strip = await readRecordWorkQueue(
      ctx.db,
      null,
      refund.shortcode,
      false,
    );
    expect(strip.items.length).toBeGreaterThan(0);
    expect(strip.meta.totalCount).toBe(strip.items.length);
    for (const row of strip.items) {
      expect(row).toMatchObject({ entity: "expense", id: refund.shortcode });
      expect(row.displayImages).toEqual([]);
    }
    expect(strip.items.map((row) => row.id)).not.toContain(line.shortcode);

    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: `${prefix} widget`, categoryId: null }),
      ctx.actor,
    );
    const runId = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      { purpose: "ai_suggest" },
    );
    await publishFieldAssessment(
      ctx.db,
      {
        runId,
        entity: "product",
        recordId: await resolveOrThrow(ctx.db, "product", product.id),
        field: "categoryId",
        currentValue: null,
        suggestedValue: "CAT-2222",
        confidence: 0.9,
        model: "typesafe/jev",
        kind: "addition",
        status: "pending",
      },
      true,
    );
    // The household's Work has one row for the family; the record's own Work
    // counts the record's own Suggestions, never the family aggregate.
    const queue = await read({});
    expect(queue.items).toContainEqual(
      expect.objectContaining({ suggestionFamily: "field", entity: null }),
    );
    const productStrip = await readRecordWorkQueue(
      ctx.db,
      null,
      product.id,
      false,
    );
    expect(productStrip.items.length).toBeGreaterThan(0);
    for (const row of productStrip.items) {
      expect(row.suggestionFamily).toBeUndefined();
      expect(row).toMatchObject({ entity: "product", id: product.id });
    }
    expect(productStrip.items).toContainEqual(
      expect.objectContaining({
        source: "suggestion",
        reason: "1 pending field suggestion",
      }),
    );

    // Member-only reads fence another member's source work identically.
    const otherUserId = testUserId("synthetic-record-strip-other-user");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Synthetic strip other member",
      email: "synthetic-strip-other@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const first = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic strip first member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const second = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic strip second member",
      kind: "member",
      userId: otherUserId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `${prefix} private vendor`,
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: second.id,
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: `${prefix} private merchandise`,
      productExpectation: "required",
    });
    const privateOrder = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      spendingCategoryId: category.id,
      displayLabel: `${prefix} private order`,
      date: "2026-09-20",
    });
    const privateLine = await insertWithShortcode(ctx.db, "expense", {
      name: `${prefix} private line`,
      purchaseId: privateOrder.id,
      cost: 12,
      date: "2026-09-20",
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
      economicRole: "vendor",
    });
    const household = await readRecordWorkQueue(
      ctx.db,
      first.id,
      privateLine.shortcode,
      false,
    );
    expect(household.items.length).toBeGreaterThan(0);
    for (const row of household.items)
      expect(row.waitingFor).toEqual({
        kind: "members",
        members: [{ id: second.shortcode, name: second.name }],
      });
    const fenced = await readRecordWorkQueue(
      ctx.db,
      first.id,
      privateLine.shortcode,
      true,
    );
    expect(fenced.items).toEqual([]);
    expect(fenced.meta.totalCount).toBe(0);
  });
});
