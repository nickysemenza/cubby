import { runShortcode } from "@cubby/schemas/identifiers";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { auditLog } from "~/server/db/schema";
import { startOrResumeRun } from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

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
  "run.import-evidence",
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
      label: "Report account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
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
