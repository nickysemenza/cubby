import { runShortcode } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { auditLog, run as runTable, runOperation } from "~/server/db/schema";
import { startPhotoInventoryRun } from "~/server/domains/purchase-import/repo/run-service";
import { startImportRunFixture } from "~/server/domains/purchase-import/service/import-run.fixtures";
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
  "run.import-approvals",
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

  it("reports a live import run's counts with its status and liveness", async () => {
    const { id } = await startRun();
    const report = await buildEntityReport(ctx.db, {
      slot: "run.import-stats",
      id,
    });
    expect(report.live).toBe(true);
    expect(report.status).toBe("running");
    expect(report.blocks[0]?.kind).toBe("stats");
  });

  it("shows the live progress variant and hides the stopped one while the run moves", async () => {
    const { id } = await startRun();
    const live = await buildEntityReport(ctx.db, {
      slot: "run.import-progress-live",
      id,
    });
    const stopped = await buildEntityReport(ctx.db, {
      slot: "run.import-progress-stopped",
      id,
    });
    expect(live.blocks.length).toBeGreaterThan(0);
    expect(stopped.blocks).toEqual([]);
  });

  it("composes live progress on its own", async () => {
    const { id } = await startRun();
    const report = await buildEntityReport(ctx.db, {
      slot: "run.live-progress",
      id,
    });
    expect(report.blocks[0]).toMatchObject({ kind: "note", text: "Working…" });
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
    const report = await buildEntityReport(ctx.db, { slot: "run.changes", id });
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
    const batch = await countTestDbQueries(() =>
      buildEntityReports(ctx.db, { id, slots: [...POLLED] }),
    );
    const timeline = batch.result.reports.find(
      (entry) => entry.slot === "run.import-timeline",
    )?.report;
    const rows = timeline?.blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    expect(rows?.map((row) => row.key)).toEqual([operationId]);
    expect(JSON.stringify(timeline)).not.toContain("Synthetic result");
    const importReports = batch.result.reports.filter(
      ({ slot }) =>
        slot !== "run.live-progress" && slot !== "run.import-timeline",
    );
    expect(importReports.flatMap(({ report }) => report.blocks)).toEqual([]);
    console.info(
      "Run report read evidence",
      JSON.stringify({
        workload: "synthetic-photo-polled-reports",
        sqlCount: batch.queryCount,
      }),
    );
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
      id,
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

  it("reads every polled run slot in one batch that loads the run once", async () => {
    const { id } = await startRun();
    const singles = await countTestDbQueries(async () => {
      const out = [];
      for (const slot of POLLED)
        out.push(await buildEntityReport(ctx.db, { slot, id }));
      return out;
    });
    const batch = await countTestDbQueries(() =>
      buildEntityReports(ctx.db, { slots: [...POLLED], id }),
    );
    expect(batch.result.reports.map((entry) => entry.slot)).toEqual([
      ...POLLED,
    ]);
    expect(batch.result.reports[2]?.report.live).toBe(true);
    // One run detail load serves every slot, so the batch costs about one slot's queries.
    expect(batch.queryCount).toBeLessThan(singles.queryCount / 3);
    expect(batch.result.reports.map((entry) => entry.report.blocks)).toEqual(
      singles.result.map((report) => report.blocks),
    );
  });

  // Duplicates used to reread progress/log/usage even in the Run-specific batch.
  it("shares repeated Run dependencies without dropping duplicate slots", async () => {
    const { id } = await startRun();
    const slots = [
      "run.live-progress",
      "run.import-debug-log",
      "run.ai-usage",
      "run.changes",
      "run.import-stats",
    ] as const;
    const one = await countTestDbQueries(() =>
      buildEntityReports(ctx.db, { id, slots: [...slots] }),
    );
    const repeated = await countTestDbQueries(() =>
      buildEntityReports(ctx.db, { id, slots: [...slots, ...slots] }),
    );
    expect(repeated.queryCount).toBe(one.queryCount);
    expect(repeated.result.reports.map(({ slot }) => slot)).toEqual([
      ...slots,
      ...slots,
    ]);
    expect(repeated.result.reports.map(({ report }) => report)).toEqual(
      [...one.result.reports, ...one.result.reports].map(
        ({ report }) => report,
      ),
    );
  });

  it("shares the Run identity across distinct polled slots", async () => {
    const { id } = await startRun();
    const batch = await countTestDbQueries(() =>
      buildEntityReports(ctx.db, {
        id,
        slots: ["run.import-stats", "run.ai-usage", "run.changes"],
      }),
    );
    expect(
      batch.statements.filter((statement) =>
        statement.startsWith('select "id" from "Run"'),
      ),
    ).toHaveLength(1);
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
    const first = await buildEntityReport(ctx.db, { id, slot: "run.changes" });
    expect(first.nextCursor).toBeTruthy();
    const second = await buildEntityReport(ctx.db, {
      id,
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
      id,
    });
    expect(log.blocks.length).toBeGreaterThan(0);
    const usage = await buildEntityReport(ctx.db, { slot: "run.ai-usage", id });
    expect(usage.blocks.at(-1)).toMatchObject({
      kind: "records",
      empty: "No AI calls were recorded for this run.",
    });
    await expect(
      buildEntityReport(ctx.db, { slot: "run.ai-usage", id: "RUN-9Z9Z" }),
    ).rejects.toThrow("was not found");
  });
});
