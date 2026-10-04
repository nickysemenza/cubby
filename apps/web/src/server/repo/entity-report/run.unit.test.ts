import type { ReportBlock } from "@cubby/schemas/entity-report";
import { expenseShortcode, runShortcode } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import type { RunDetail } from "~/contracts/run.contract";

import {
  aiUsageBlocks,
  changesBlocks,
  importReportBlocks,
  isLiveRunStatus,
  liveProgressBlocks,
  runLogBlocks,
} from "./run";

const RUN_ID = runShortcode.parse("RUN-4K7M");
const FINDING_ID = "8f0d4c2a-6b1e-4c7a-9a52-0d3f1e5b7c91";

const baseRun: RunDetail = {
  publicId: RUN_ID,
  status: "completed",
  purpose: "purchase_validation",
  trigger: "manual",
  startedAt: "2026-09-20T16:00:00.000Z",
  endedAt: "2026-09-20T16:03:00.000Z",
  ordersSeen: 3,
  imported: 1,
  updated: 1,
  skipped: 1,
  failureCode: null,
  notes: null,
  predecessorRunPublicId: null,
  successorRunPublicId: null,
  restartInputs: null,
  coordinatorModel: "test-model",
  skillRevision: null,
  runtimeRevision: null,
  agentModelMs: 0,
  source: { kind: "vendor export", vendorName: "Fixture vendor" },
  actor: { name: "Fixture member", ledgerParty: null },
  controllingMembers: [],
  controlHistory: [],
  vendorAccount: { id: "account-1", label: "Fixture vendor" },
  affectedPurchases: [],
  findings: [],
  operations: [],
  preparedOrders: [],
  targets: [],
  evidence: [],
  dispatch: {
    eventId: "event-1",
    state: "started",
    attempts: 1,
    error: null,
    coordinatorStartedAt: "2026-09-20T16:00:01.000Z",
  },
  progress: [],
  latestProgress: null,
  approvals: [],
};

const run = (overrides: Partial<RunDetail> = {}): RunDetail => ({
  ...baseRun,
  ...overrides,
});

type Records = Extract<ReportBlock, { kind: "records" }>;

/** The records block with `title` (or the first untitled one). */
const recordsOf = (blocks: ReportBlock[], title?: string): Records => {
  const found = blocks.find(
    (block): block is Records =>
      block.kind === "records" && block.title === title,
  );
  if (!found) throw new Error(`no records block ${title ?? "(untitled)"}`);
  return found;
};

const notes = (blocks: ReportBlock[]) =>
  blocks.flatMap((block) => (block.kind === "note" ? [block.text] : []));

describe("import report blocks", () => {
  it("reports the four order counts as figures", () => {
    const [stats] = importReportBlocks("run.import-stats", run());
    expect(stats).toEqual({
      kind: "stats",
      figures: [
        { label: "Orders seen", value: 3, format: "count" },
        { label: "Imported", value: 1, format: "count" },
        { label: "Updated", value: 1, format: "count" },
        { label: "Skipped", value: 1, format: "count" },
      ],
    });
  });

  it("composes nothing for a run that is not an import workflow", () => {
    for (const purpose of ["ai_suggest", "mail_search"] as const)
      expect(importReportBlocks("run.import-stats", run({ purpose }))).toEqual(
        [],
      );
  });

  it("gives a photo batch only its durable transcript", () => {
    const photo = run({ purpose: "photo_inventory" });
    expect(importReportBlocks("run.import-stats", photo)).toEqual([]);
    expect(
      importReportBlocks("run.import-timeline", photo).length,
    ).toBeGreaterThan(0);
  });

  it("links each changed purchase to its record", () => {
    const blocks = importReportBlocks(
      "run.import-purchases",
      run({
        affectedPurchases: [
          {
            shortcode: "PUR-ABCDE12345",
            displayName: "Fixture purchase",
            orderId: "fixture-order",
          },
        ],
      }),
    );
    expect(recordsOf(blocks).rows[0]).toMatchObject({
      title: "Fixture purchase",
      entity: "purchase",
      id: "PUR-ABCDE12345",
    });
    expect(
      recordsOf(importReportBlocks("run.import-purchases", run())).empty,
    ).toBe("No purchases were changed by this run.");
  });

  it("leaves out targets and evidence for a run that retained neither", () => {
    expect(importReportBlocks("run.import-targets", run())).toEqual([]);
    expect(importReportBlocks("run.import-evidence", run())).toEqual([]);
  });

  it("describes a target's frozen source, outcome and warning", () => {
    const blocks = importReportBlocks(
      "run.import-targets",
      run({
        targets: [
          {
            id: "target-1",
            targetType: "purchase",
            targetShortcode: "PUR-ABCDE12345",
            targetName: "Fixture purchase",
            sourceId: null,
            sourceLabel: "browser order · fixture-order",
            vendorAccountLabel: "Fixture vendor",
            state: "unresolved",
            fingerprint: null,
            outcome: "replayed",
            warning: "Order total changed",
            diff: null,
            completedAt: null,
          },
        ],
      }),
    );
    const [target] = recordsOf(blocks).rows;
    expect(target?.title).toBe("Fixture purchase");
    expect(target?.statuses).toEqual([{ label: "unresolved" }]);
    expect(target?.lines).toEqual([
      { text: "browser order · fixture-order · Fixture vendor", tone: "muted" },
      { text: "Outcome: replayed" },
      { text: "Order total changed", tone: "warning" },
    ]);
    expect([target?.entity, target?.id]).toEqual([
      "purchase",
      "PUR-ABCDE12345",
    ]);
  });

  it("lists the run's evidence by filename", () => {
    const blocks = importReportBlocks(
      "run.import-evidence",
      run({
        evidence: [
          {
            id: "evidence-1",
            targetId: null,
            sourceKind: "browser_capture",
            filename: "fixture-order.pdf",
            mediaType: "application/pdf",
            checksum: "fixture-checksum",
            createdAt: "2026-09-20T16:00:00.000Z",
          },
        ],
      }),
    );
    expect(recordsOf(blocks).rows[0]).toMatchObject({
      title: "fixture-order.pdf",
      lines: [
        {
          text: "browser_capture · application/pdf · fixture-checksum",
          tone: "muted",
        },
      ],
    });
  });

  it("lists operations oldest first and shows a failed operation's raw error", () => {
    const blocks = importReportBlocks(
      "run.import-timeline",
      run({
        operations: [
          {
            operationId: "extract-1",
            kind: "extract",
            state: "failed",
            startedAt: "2026-09-20T16:01:00.000Z",
            completedAt: null,
            error: 'relation "x" does not exist (SQLSTATE 42P01)',
          },
        ],
      }),
    );
    const [operation] = recordsOf(blocks).rows;
    expect(operation).toMatchObject({
      title: "extract",
      at: "2026-09-20T16:01:00.000Z",
      statuses: [{ label: "failed", tone: "destructive" }],
    });
    expect(operation?.lines).toContainEqual({
      text: 'relation "x" does not exist (SQLSTATE 42P01)',
      tone: "destructive",
    });
  });

  describe("progress", () => {
    const update = {
      eventId: "progress-1",
      phase: "investigating",
      currentItem: "IMG-4S9Q",
      awaitingApproval: false,
      detail: "Checking the label.",
      createdAt: "2026-09-20T16:02:00.000Z",
    };
    const later = {
      ...update,
      eventId: "progress-2",
      phase: "committing",
      currentItem: null,
      detail: null,
      createdAt: "2026-09-20T16:02:30.000Z",
    };

    it("describes the latest update and lists history newest first", () => {
      const blocks = importReportBlocks(
        "run.import-progress-live",
        run({
          status: "running",
          progress: [update, later],
          latestProgress: later,
          controllingMembers: [
            { name: "Fixture member", ledgerParty: null },
            { name: null, ledgerParty: { id: null, name: "Fixture party" } },
          ],
          controlHistory: [
            {
              name: "Fixture member",
              ledgerParty: null,
              action: "resume",
              createdAt: "2026-09-20T16:01:30.000Z",
            },
          ],
        }),
      );
      expect(notes(blocks)).toEqual([
        "committing",
        "Controlled by Fixture member, Fixture party.",
      ]);
      expect(
        recordsOf(blocks, "Run progress history").rows.map((r) => r.title),
      ).toEqual([
        "committing",
        "investigating · IMG-4S9Q · Checking the label.",
      ]);
      expect(recordsOf(blocks, "Control history").rows[0]?.title).toBe(
        "Fixture member resume",
      );
    });

    it("composes the live variant only while running and the stopped one after", () => {
      const live = run({ status: "running" });
      expect(importReportBlocks("run.import-progress-live", live)).not.toEqual(
        [],
      );
      expect(importReportBlocks("run.import-progress-stopped", live)).toEqual(
        [],
      );
      const stopped = run({ status: "needs_review" });
      expect(importReportBlocks("run.import-progress-live", stopped)).toEqual(
        [],
      );
      expect(
        importReportBlocks("run.import-progress-stopped", stopped),
      ).not.toEqual([]);
    });

    it("says so when no update was recorded", () => {
      const blocks = importReportBlocks(
        "run.import-progress-live",
        run({ status: "running" }),
      );
      expect(notes(blocks)).toEqual([
        "No progress updates have been recorded.",
      ]);
    });
  });

  describe("approvals", () => {
    const approval = {
      id: "approval-1",
      operationId: "op-1",
      operationKind: "product_overwrite",
      args: { productId: "PRD-4K7M" },
      state: "pending",
      grantedAt: null,
      consumedAt: null,
      invalidatedAt: null,
      rejectedAt: null,
    };

    it("offers approve and reject for a pending approval with the exact ids and a confirmation", () => {
      const blocks = importReportBlocks(
        "run.import-approvals",
        run({ status: "paused_approval", approvals: [approval] }),
      );
      const [pending] = recordsOf(blocks).rows;
      expect(pending?.detail?.label).toBe("Proposed arguments");
      expect(JSON.parse(pending?.detail?.text ?? "null")).toEqual({
        productId: "PRD-4K7M",
      });
      expect(pending?.commands?.map((action) => action.label)).toEqual([
        "Approve import proposal",
        "Reject import proposal",
      ]);
      expect(pending?.commands?.map((action) => action.request)).toEqual([
        {
          kind: "run-control",
          runId: RUN_ID,
          action: "approve",
          operationId: "op-1",
          approvalId: "approval-1",
        },
        {
          kind: "run-control",
          runId: RUN_ID,
          action: "reject",
          operationId: "op-1",
          approvalId: "approval-1",
        },
      ]);
      // Neither decision may run on a stray tap.
      for (const action of pending?.commands ?? [])
        expect(action.confirm).toBeTruthy();
      expect(pending?.lines).toContainEqual({
        text: "Awaiting explicit approval",
        tone: "warning",
      });
    });

    it("offers nothing for a decided approval", () => {
      const blocks = importReportBlocks(
        "run.import-approvals",
        run({
          approvals: [
            {
              ...approval,
              state: "granted",
              grantedAt: "2026-09-20T16:02:00.000Z",
            },
            {
              ...approval,
              id: "approval-2",
              state: "rejected",
              rejectedAt: "2026-09-20T16:02:10.000Z",
            },
          ],
        }),
      );
      const rows = recordsOf(blocks).rows;
      expect(rows.flatMap((r) => r.commands)).toEqual([]);
      expect(rows.map((r) => [r.lines?.[0]?.text, r.at])).toEqual([
        ["Granted", "2026-09-20T16:02:00.000Z"],
        ["Rejected", "2026-09-20T16:02:10.000Z"],
      ]);
    });
  });

  describe("findings", () => {
    const finding = {
      id: FINDING_ID,
      kind: "wrong_product",
      summary: "Line 2 matched the wrong Product.",
      status: "open",
      proposedFix: null,
      autoApplied: false,
      probability: 0.8,
      createdAt: "2026-09-20T16:02:00.000Z",
      expiresAt: null,
    } satisfies RunDetail["findings"][number];
    const firstRow = (findings: RunDetail["findings"]) =>
      recordsOf(importReportBlocks("run.import-findings", run({ findings })))
        .rows[0];
    const purchaseId = "0e6c4a7a-3e61-4d53-b8d7-8a2f3b6a1c11";

    it("offers only dismiss when the finding proposes no fix", () => {
      const row = firstRow([finding]);
      expect(row?.commands?.map((action) => action.request)).toEqual([
        {
          kind: "resolve-finding",
          findingId: FINDING_ID,
          decision: "dismiss",
          reviewedFingerprint: null,
        },
      ]);
      expect(row?.at).toBe("2026-09-20T16:02:00.000Z");
      expect(row?.lines?.at(-1)?.text).toBe("Probability 80%");
    });

    it("offers apply for a fix, carrying the fingerprint the person was shown", () => {
      const row = firstRow([
        {
          ...finding,
          proposedFix: {
            kind: "replace_aggregate_line",
            purchaseId,
            lines: [],
            reviewSnapshot: {
              fingerprint: "f".repeat(64),
              expenseCode: expenseShortcode.parse("EXP-2A3B"),
              title: "Aggregate line",
              amount: 12.5,
              notes: null,
              date: "2026-09-19",
              projectName: null,
              categoryName: null,
              costType: "product",
              trade: null,
              bookingTransactionCode: null,
            },
          },
        },
      ]);
      const apply = row?.commands?.find((action) =>
        action.id.endsWith("apply"),
      );
      expect(apply?.request).toEqual({
        kind: "resolve-finding",
        findingId: FINDING_ID,
        decision: "apply",
        reviewedFingerprint: "f".repeat(64),
      });
      expect(apply?.confirm).toContain("Aggregate line");
      expect(row?.lines?.map((l) => l.text)).toContain(
        "Replace Aggregate line ($12.50) with the receipt lines below.",
      );
    });

    it("withholds apply from a replacement the server has not reviewed, and from receive_purchase", () => {
      for (const proposedFix of [
        { kind: "replace_aggregate_line" as const, purchaseId, lines: [] },
        { kind: "receive_purchase" as const, purchaseId },
      ])
        expect(
          firstRow([{ ...finding, proposedFix }])?.commands?.map((a) => a.id),
        ).toEqual([`${FINDING_ID}:dismiss`]);
    });

    it("drops the review lines of a finding that is no longer open", () => {
      const row = firstRow([
        {
          ...finding,
          status: "applied",
          proposedFix: {
            kind: "replace_aggregate_line",
            purchaseId,
            lines: [],
          },
        },
      ]);
      expect(row?.lines?.map((l) => l.text)).toEqual(["Probability 80%"]);
    });

    it("offers nothing once a finding is resolved", () => {
      const row = firstRow([{ ...finding, status: "dismissed" }]);
      expect(row?.commands).toEqual([]);
      expect(row?.statuses).toEqual([{ label: "dismissed" }]);
    });
  });
});

describe("isLiveRunStatus", () => {
  it.each([
    ["running", true],
    ["paused_auth", true],
    ["paused_offline", true],
    ["paused_approval", true],
    ["needs_review", false],
    ["completed", false],
    ["failed", false],
    ["dispatch_failed", false],
  ])("%s is live: %s", (status, live) => {
    expect(isLiveRunStatus(status)).toBe(live);
  });
});

describe("liveProgressBlocks", () => {
  const events = (ages: number[]) =>
    ages.map((ageSeconds, index) => ({
      id: `event-${index}`,
      phase: index === ages.length - 1 ? "rate_limited" : "preparing",
      detail: null,
      createdAt: `2026-09-20T16:0${index}:00.000Z`,
      ageSeconds,
    }));
  const progress = {
    status: "running" as const,
    progress: events([300, 200]),
    gmail: {
      status: "queued" as const,
      searched: 40,
      skipped: 10,
      reviewable: 3,
      pagesScanned: 1,
      after: "1970/01/01",
      searchTerms: ["orders@fixture.test"],
      startedFromOlderPage: false,
      hasMorePages: true,
      error: null,
    },
    orders: [{ orderId: "fixture-order", state: "pending" as const }],
    charges: [],
  };
  const actionsOf = (blocks: ReportBlock[]) =>
    blocks.flatMap((block) =>
      block.kind === "records"
        ? block.rows.flatMap((r) => r.commands ?? [])
        : [],
    );

  it("offers a queue retry only after a queued Gmail task has waited three minutes", () => {
    const waiting = liveProgressBlocks(RUN_ID, progress);
    expect(notes(waiting)[0]).toBe("AI Gateway rate limited; waiting to retry");
    expect(actionsOf(waiting).map((action) => action.request)).toEqual([
      { kind: "retry-gmail-search", runId: RUN_ID },
    ]);
    // The retry block is titled so it never shares a key with the untitled progress rows.
    expect(
      waiting.find(
        (block) => block.kind === "records" && block.rows[0]?.key === "queue",
      ),
    ).toMatchObject({ title: "Background queue" });
    expect(
      actionsOf(
        liveProgressBlocks(RUN_ID, { ...progress, progress: events([20, 10]) }),
      ),
    ).toEqual([]);
  });

  it("states the search inputs and the per-order outcomes", () => {
    const blocks = liveProgressBlocks(RUN_ID, progress);
    expect(
      recordsOf(blocks, "Search inputs").rows.map((r) => [r.title, r.subtitle]),
    ).toEqual([
      ["Date range", "All available mail"],
      ["Sender search", "orders@fixture.test"],
      ["Starting point", "Newest matching email"],
    ]);
    expect(recordsOf(blocks, "Selected orders").rows[0]).toMatchObject({
      title: "fixture-order",
      statuses: [{ label: "Waiting" }],
    });
  });

  it("closes with the run's outcome once it has stopped", () => {
    expect(
      notes(
        liveProgressBlocks(RUN_ID, {
          ...progress,
          status: "completed",
          gmail: null,
        }),
      )[0],
    ).toBe("Run completed");
  });
});

describe("runLogBlocks", () => {
  it("shows each event with its source and warns when the log was cut", () => {
    const blocks = runLogBlocks({
      truncated: true,
      entries: [
        {
          id: "e1",
          occurredAt: "2026-09-20T16:00:00.000Z",
          source: "mac",
          level: "error",
          event: "bridge.disconnected",
          state: null,
          commandId: null,
          operationId: null,
          operationKind: null,
          host: null,
          browser: null,
          attempt: null,
          count: null,
          outcome: null,
          messageType: null,
          errorType: null,
          errorCode: null,
          error: "socket closed",
        },
      ],
    });
    expect(recordsOf(blocks).rows[0]).toMatchObject({
      title: "bridge.disconnected",
      statuses: [{ label: "mac", tone: "destructive" }],
      lines: [{ text: "socket closed", tone: "destructive" }],
    });
    expect(blocks.at(-1)).toMatchObject({
      kind: "note",
      text: "This view is limited to the first 2,000 events.",
      tone: "warning",
    });
  });
});

describe("aiUsageBlocks", () => {
  const usage = {
    pricedSubtotal: 0.0123,
    unpricedCount: 2,
    nextCursor: "cursor-2",
    records: [
      {
        id: "call-1",
        createdAt: new Date("2026-09-20T16:00:00.000Z"),
        feature: "import",
        operation: "extract",
        provider: "fixture-provider",
        model: "fixture-model",
        attempt: 1,
        inputTokens: 100,
        outputTokens: null,
        cacheReadTokens: 5,
        cacheWriteTokens: null,
        durationMs: 1500,
        status: "succeeded" as const,
        gatewayLogId: "log-1",
        cacheStatus: "miss" as const,
        applicationCacheStatus: "hit" as const,
        estimatedCost: null,
      },
    ],
  };

  it("flags an estimated subtotal", () => {
    expect(notes(aiUsageBlocks(usage))[0]).toBe(
      "Estimated subtotal $0.0123 · 2 unpriced",
    );
  });

  it("describes each call with its tokens, cache and cost", () => {
    const [call] = recordsOf(aiUsageBlocks(usage)).rows;
    expect(call?.title).toBe("extract · import · fixture-provider");
    expect(call?.statuses).toEqual([{ label: "succeeded", tone: "positive" }]);
    expect(call?.lines?.map((l) => l.text)).toEqual([
      "fixture-model · attempt 1",
      "100 in / — out",
      "Application hit · no model call · Gateway miss · 5 read / — write",
      "1.5s · unpriced · log-1",
    ]);
  });
});

describe("changesBlocks", () => {
  it("summarizes each audit entry and links to the record it changed", () => {
    const [entry] = recordsOf(
      changesBlocks({
        nextCursor: "next",
        entries: [
          {
            entryKey: "entry-1",
            entityKind: "purchase",
            entityId: "PUR-ABCDE12345",
            canonicalEntityId: null,
            entityName: "Fixture purchase",
            displayImage: null,
            action: "update",
            changes: { orderId: { from: "a", to: "b" } },
            userId: "user-1",
            channel: "web",
            oauthClient: null,
            device: null,
            runId: RUN_ID,
            createdAt: new Date("2026-09-20T16:00:00.000Z"),
            user: null,
          },
        ],
      }),
    ).rows;
    expect(entry).toMatchObject({
      title: "Updated purchase · Fixture purchase",
      at: "2026-09-20T16:00:00.000Z",
      entity: "purchase",
      id: "PUR-ABCDE12345",
      lines: [{ text: "orderId: a → b", tone: "muted" }],
    });
  });
});
