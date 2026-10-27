import { runShortcode } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  assessmentState,
  auditLog,
  feedback,
  run as runTable,
  runOperation,
  runStep,
} from "~/server/db/schema";
import { startPhotoInventoryRun } from "~/server/domains/purchase-import/repo/run-service";
import { startImportRunFixture } from "~/server/domains/purchase-import/service/import-run.fixtures";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  buildEntityReport as buildReport,
  buildEntityReports as buildReports,
} from ".";

/** What a Run page polls: one batched read, not one request per slot. */
const POLLED = [
  "run.live-progress",
  "run.import-stats",
  "run.import-progress-live",
  "run.import-progress-stopped",
  "run.import-purchases",
  "run.import-findings",
  "run.import-targets",
  "run.import-prepared-orders",
  "run.import-timeline",
] as const;

describe("Run detail reports", () => {
  const ctx = withTestDb();
  const buildEntityReport = (
    db: typeof ctx.db,
    input: Parameters<typeof buildReport>[1],
  ) => buildReport(db, input, async () => null, ctx.actor);
  const buildEntityReports = (
    db: typeof ctx.db,
    input: Parameters<typeof buildReports>[1],
  ) => buildReports(db, input, async () => null, ctx.actor);

  async function startRun() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Report test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Report vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
    });
    return { run, id: runShortcode.parse(run.publicId), vendor };
  }

  it("separates a publication-only Sweep from later manual applications and revisited inputs", async () => {
    const { run, id, vendor } = await startRun();
    await getDb(ctx.db)
      .update(runTable)
      .set({ purpose: "sweep", status: "completed" })
      .where(eq(runTable.id, run.id));
    await getDb(ctx.db).insert(runStep).values({
      runId: run.id,
      key: "statement_label",
      label: "Label inputs",
      position: 0,
      state: "done",
      found: 2,
      done: 3,
    });
    const publish = (key: string) =>
      publishAssessment(
        ctx.db,
        {
          publicationKey: key,
          family: "field",
          subject: {
            kind: "field",
            entity: "vendor",
            recordId: vendor.id,
            field: "name",
          },
          judgment: { value: "Synthetic reviewed vendor" },
          fingerprint: key,
          producer: {
            kind: "agent",
            model: null,
            revision: null,
            runId: run.id,
            evaluationId: null,
          },
          evidence: null,
        },
        { runId: run.id },
      );
    const first = await publish("synthetic:run-results:first");
    await publish("synthetic:run-results:second");
    const read = () =>
      buildEntityReport(ctx.db, {
        slot: "run.results",
        scope: { kind: "record", id },
      });
    const before = await read();
    const figures = (report: typeof before, title: string) =>
      report.blocks.flatMap((block) =>
        block.kind === "stats" && block.title === title ? block.figures : [],
      );
    expect(figures(before, "Changed by this Run")).toContainEqual({
      label: "Records",
      value: 0,
      format: "count",
    });
    expect(figures(before, "Suggestions published")).toEqual(
      expect.arrayContaining([
        { label: "Published", value: 2, format: "count" },
        { label: "Records assessed", value: 1, format: "count" },
      ]),
    );
    expect(before.blocks).toContainEqual(
      expect.objectContaining({
        kind: "table",
        title: "Inputs processed",
        rows: [
          expect.objectContaining({ cells: ["Label inputs", "3", "0", "0"] }),
        ],
      }),
    );
    await getDb(ctx.db)
      .insert(feedback)
      .values({
        assessmentId: first.id,
        operationId: "synthetic:later-manual",
        verdict: "correct",
        correction: { present: false },
        intent: "apply",
        authority: "member",
        actorUserId: ctx.actor.userId,
        receipt: { kind: "saved_field", recordId: vendor.id },
      });
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ status: "applied" })
      .where(eq(assessmentState.id, first.id));
    await getDb(ctx.db)
      .insert(auditLog)
      .values({
        entityKind: "vendor",
        entityId: vendor.id,
        action: "update",
        userId: ctx.actor.userId,
        channel: "web",
        changes: {
          name: { from: "Synthetic vendor", to: "Synthetic reviewed vendor" },
        },
      });
    const after = await read();
    expect(figures(after, "Changed by this Run")).toEqual(
      figures(before, "Changed by this Run"),
    );
    expect(figures(after, "Suggestions published")).toContainEqual({
      label: "Applied",
      value: 1,
      format: "count",
    });
    expect(
      after.blocks.flatMap((block) =>
        block.kind === "records" ? block.rows : [],
      ),
    ).toEqual([]);
    expect(
      after.blocks.flatMap((block) =>
        block.kind === "table" ? block.rows : [],
      ),
    ).toContainEqual(
      expect.objectContaining({
        presentation: {
          "0": {
            kind: "links",
            links: [
              {
                label: "Review this Run’s Suggestions",
                href: `/suggestions?runId=${id}`,
              },
            ],
          },
        },
      }),
    );
  });

  it("lists actual Run-owned records once while retaining distinct create and edit counts", async () => {
    const { run, id, vendor } = await startRun();
    await getDb(ctx.db)
      .insert(auditLog)
      .values(
        ["create", "update", "update"].map((action) => ({
          runId: run.id,
          entityKind: "vendor" as const,
          entityId: vendor.id,
          action,
          userId: ctx.actor.userId,
          channel: "mcp" as const,
        })),
      );
    const report = await buildEntityReport(ctx.db, {
      slot: "run.results",
      scope: { kind: "record", id },
    });
    expect(report.blocks).toContainEqual({
      kind: "stats",
      title: "Changed by this Run",
      figures: [
        { label: "Records", value: 1, format: "count" },
        { label: "Created", value: 1, format: "count" },
        { label: "Edited", value: 1, format: "count" },
        { label: "Deleted", value: 0, format: "count" },
      ],
    });
    const records = report.blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      entity: "vendor",
      id: vendor.shortcode,
      badges: [{ label: "Created" }, { label: "Edited" }],
    });
  });

  it("reports a live import run's counts with its status and liveness", async () => {
    const { id } = await startRun();
    const report = await buildEntityReport(ctx.db, {
      slot: "run.import-stats",
      scope: { kind: "record", id: id },
    });
    expect(report.live).toBe(true);
    expect(report.status).toBe("running");
    expect(report.blocks[0]?.kind).toBe("stats");
  });

  it("shows the live progress variant and hides the stopped one while the run moves", async () => {
    const { id } = await startRun();
    const live = await buildEntityReport(ctx.db, {
      slot: "run.import-progress-live",
      scope: { kind: "record", id: id },
    });
    const stopped = await buildEntityReport(ctx.db, {
      slot: "run.import-progress-stopped",
      scope: { kind: "record", id: id },
    });
    expect(live.blocks.length).toBeGreaterThan(0);
    expect(stopped.blocks).toEqual([]);
  });

  it("composes live progress on its own", async () => {
    const { id } = await startRun();
    const report = await buildEntityReport(ctx.db, {
      slot: "run.live-progress",
      scope: { kind: "record", id: id },
    });
    expect(report.blocks[0]).toMatchObject({
      kind: "progress",
      label: "Importing",
      processed: 0,
      total: null,
    });
    expect(report.blocks).toContainEqual(
      expect.objectContaining({ kind: "note", text: "Working…" }),
    );
  });

  it("lists the audit entries the run wrote with a link to each record", async () => {
    const { run, id, vendor } = await startRun();
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
      displayLabel: "Report purchase",
    });
    await getDb(ctx.db)
      .insert(auditLog)
      .values({
        runId: run.id,
        entityKind: "purchase",
        entityId: purchase.id,
        action: "update",
        changes: { displayLabel: { from: "Old", to: "Report purchase" } },
        userId: ctx.actor.userId,
        channel: "mcp",
      });
    const report = await buildEntityReport(ctx.db, {
      slot: "run.changes",
      scope: { kind: "record", id: id },
    });
    const block = report.blocks[0];
    if (block?.kind !== "records") throw new Error("expected records");
    expect(block.rows[0]?.title).toContain("Updated purchase");
    expect(block.rows[0]?.entity).toBe("purchase");
    expect(block.rows[0]?.lines?.map((line) => line.text)).toContain(
      "displayLabel: Old → Report purchase",
    );
  });

  // Photo Runs have no import reports; their durable timeline must not load
  // targets, prepared orders, or restart inputs on each report poll. Private
  // provider receipts stay hidden and the next request must see new work.
  it("polls photo Run reports with only their public operation evidence", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic photo report member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const id = runShortcode.parse(run.publicId);
    const operationId = "synthetic-photo-work";
    await getDb(ctx.db)
      .insert(runOperation)
      .values([
        {
          runId: run.id,
          operationId,
          kind: "synthetic_photo_work",
          inputFingerprint: "a".repeat(64),
          startedAt: new Date("2026-09-20T00:00:00Z"),
          state: "completed",
          result: { privatePayload: "Synthetic result" },
        },
        {
          runId: run.id,
          operationId: "synthetic-private-receipt",
          kind: "research_mail_page",
          inputFingerprint: "b".repeat(64),
          state: "completed",
        },
      ]);
    const batch = await buildEntityReports(ctx.db, { id, slots: [...POLLED] });
    const timeline = batch.reports.find(
      (entry) => entry.slot === "run.import-timeline",
    )?.report;
    const rows = timeline?.blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    expect(rows?.map((row) => row.key)).toEqual([operationId]);
    expect(JSON.stringify(timeline)).not.toContain("Synthetic result");
    const importReports = batch.reports.filter(
      ({ slot }) =>
        slot !== "run.live-progress" && slot !== "run.import-timeline",
    );
    expect(importReports.flatMap(({ report }) => report.blocks)).toEqual([]);
    await getDb(ctx.db)
      .insert(runOperation)
      .values({
        runId: run.id,
        operationId: "synthetic-new-work",
        kind: "synthetic_photo_work",
        inputFingerprint: "c".repeat(64),
        startedAt: new Date("2026-09-20T00:00:01Z"),
        state: "completed",
      });
    const next = await buildEntityReport(ctx.db, {
      scope: { kind: "record", id: id },
      slot: "run.import-timeline",
    });
    const nextRows = next.blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    expect(nextRows).toHaveLength(1);
    expect(nextRows[0]).toMatchObject({
      key: operationId,
      trailing: "×2",
      detail: { label: "2 events" },
    });
    expect(nextRows[0]?.detail?.text).toContain(operationId);
    expect(nextRows[0]?.detail?.text).toContain("synthetic-new-work");
  });

  it("reads every polled run slot in one batch matching individual reads", async () => {
    const { id } = await startRun();
    const singles = [];
    for (const slot of POLLED)
      singles.push(
        await buildEntityReport(ctx.db, {
          slot,
          scope: { kind: "record", id: id },
        }),
      );
    const batch = await buildEntityReports(ctx.db, { slots: [...POLLED], id });
    expect(batch.reports.map((entry) => entry.slot)).toEqual([...POLLED]);
    expect(batch.reports[2]?.report.live).toBe(true);
    expect(batch.reports.map((entry) => entry.report.blocks)).toEqual(
      singles.map((report) => report.blocks),
    );
  });

  it("keeps duplicate Run slots", async () => {
    const { id } = await startRun();
    const slots = [
      "run.live-progress",
      "run.import-debug-log",
      "run.ai-usage",
      "run.changes",
      "run.import-stats",
    ] as const;
    const one = await buildEntityReports(ctx.db, { id, slots: [...slots] });
    const repeated = await buildEntityReports(ctx.db, {
      id,
      slots: [...slots, ...slots],
    });
    expect(repeated.reports.map(({ slot }) => slot)).toEqual([
      ...slots,
      ...slots,
    ]);
    expect(repeated.reports.map(({ report }) => report)).toEqual(
      [...one.reports, ...one.reports].map(({ report }) => report),
    );
  });

  it("keeps paged Run cursors and reads updated status on the next request", async () => {
    const { run, id, vendor } = await startRun();
    await getDb(ctx.db)
      .insert(auditLog)
      .values(
        Array.from({ length: 26 }, (_, index) => ({
          runId: run.id,
          entityKind: "vendor" as const,
          entityId: vendor.id,
          action: "update",
          userId: ctx.actor.userId,
          channel: "mcp" as const,
          changes: { name: { from: "Before", to: `Page fixture ${index}` } },
          createdAt: new Date(Date.UTC(2026, 8, 20, 0, 0, index)),
        })),
      );
    const first = await buildEntityReport(ctx.db, {
      scope: { kind: "record", id: id },
      slot: "run.changes",
    });
    expect(first.nextCursor).toBeTruthy();
    const second = await buildEntityReport(ctx.db, {
      scope: { kind: "record", id: id },
      slot: "run.changes",
      cursor: first.nextCursor,
    });
    const rows = (report: typeof first) =>
      report.blocks.flatMap((block) =>
        block.kind === "records" ? block.rows : [],
      );
    expect(rows(first)).toHaveLength(25);
    expect(rows(second)).toHaveLength(1);
    expect(rows(first).map(({ key }) => key)).not.toContain(
      rows(second)[0]?.key,
    );
    expect(second.nextCursor).toBeUndefined();
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed" })
      .where(eq(runTable.id, run.id));
    const stopped = await buildEntityReports(ctx.db, {
      id,
      slots: ["run.changes", "run.import-stats"],
    });
    expect(
      stopped.reports.map(({ report }) => [report.status, report.live]),
    ).toEqual([
      ["completed", false],
      ["completed", false],
    ]);
  });

  it("serves the log and usage reports, and refuses an unknown run", async () => {
    const { id } = await startRun();
    const log = await buildEntityReport(ctx.db, {
      slot: "run.import-debug-log",
      scope: { kind: "record", id: id },
    });
    expect(log.blocks.length).toBeGreaterThan(0);
    const usage = await buildEntityReport(ctx.db, {
      slot: "run.ai-usage",
      scope: { kind: "record", id: id },
    });
    expect(usage.blocks.at(-1)).toMatchObject({
      kind: "records",
      empty: "No AI calls were recorded for this run.",
    });
    await expect(
      buildEntityReport(ctx.db, {
        slot: "run.ai-usage",
        scope: { kind: "record", id: "RUN-9Z9Z" },
      }),
    ).rejects.toThrow("was not found");
  });
});
