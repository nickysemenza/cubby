import type { ReportBlock } from "@cubby/schemas/entity-report";
import {
  expenseShortcode,
  productShortcode,
  runShortcode,
} from "@cubby/schemas/identifiers";
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

describe("prepared orders", () => {
  // Failure modes this guards: a single exact match silently chosen for the person (identity
  // is explicit); two exact matches shown without the conflict; an adjustment line asked for a
  // Product; a committed or stopped run still offering Approve; a trade demanded when no line
  // needs one; a resolution sent against the wrong order or batch; a commit with no confirmation.
  type Prepared = RunDetail["preparedOrders"][number];
  const candidate = (
    productId: string,
    name: string,
    exactIdentifierMatch: boolean,
  ) => ({
    productId: productShortcode.parse(productId),
    name,
    manufacturer: "Fixture maker",
    model: null,
    exactIdentifierMatch,
  });
  const line = (
    stableLineId: string,
    overrides: Partial<Prepared["lines"][number]> = {},
  ): Prepared["lines"][number] => ({
    stableLineId,
    title: `Item ${stableLineId}`,
    amount: 12.5,
    identifiers: { sku: `SKU-${stableLineId}` },
    candidates: [],
    requiresProductResolution: true,
    ...overrides,
  });
  const order = (
    stableOrderId: string,
    lines: Prepared["lines"],
    overrides: Partial<Prepared> = {},
  ): Prepared => ({
    stableOrderId,
    prepareOperationId: "prepare-1",
    itemOperationId: `item-${stableOrderId}`,
    sourceKind: "retailer",
    externalKey: `ORDER-${stableOrderId}`,
    preparedAt: "2026-09-20T16:00:00.000Z",
    lineCount: lines.length,
    committed: false,
    lines,
    ...overrides,
  });
  const reviewing = (preparedOrders: Prepared[], overrides = {}) =>
    run({
      purpose: "account_sync",
      status: "running",
      preparedOrders,
      ...overrides,
    });
  const formOf = (blocks: ReportBlock[]) => {
    const form = recordsOf(blocks).form;
    if (!form) throw new Error("no form");
    return form;
  };

  it("says so when no order was prepared, and composes nothing for a photo batch", () => {
    expect(
      importReportBlocks("run.import-prepared-orders", reviewing([])),
    ).toEqual([{ kind: "note", text: "No orders were prepared." }]);
    expect(
      importReportBlocks(
        "run.import-prepared-orders",
        reviewing([order("o1", [line("l1")])], { purpose: "photo_inventory" }),
      ),
    ).toEqual([]);
  });

  it("asks for an explicit decision on every Product line and preselects none", () => {
    const blocks = importReportBlocks(
      "run.import-prepared-orders",
      reviewing([
        order("o1", [
          // One exact match is a suggestion only: identity is never chosen for the person.
          line("l1", {
            candidates: [candidate("PRD-4K7M", "Exact thing", true)],
          }),
          line("l2"),
        ]),
      ]),
    );
    const rows = recordsOf(blocks).rows;
    expect(rows.map((row) => row.title)).toEqual([
      "retailer · ORDER-o1",
      "Item l1",
      "Item l2",
    ]);
    const choice = rows[1]?.choice;
    expect(choice).toMatchObject({
      id: "o1/l1",
      label: "Product decision for Item l1",
      required: true,
    });
    expect(choice?.options.map((option) => option.id)).toEqual([
      "existing",
      "new",
      "unresolved",
      "expense_only",
    ]);
    expect(choice?.options[0]?.pick).toEqual({
      entity: "product",
      label: "Product for Item l1",
    });
    expect(choice?.options[2]?.text?.label).toBe(
      "Reason for leaving Item l1 unresolved",
    );
    expect(choice?.suggestions).toEqual([
      {
        optionId: "existing",
        entity: "product",
        id: "PRD-4K7M",
        name: "Exact thing",
        label: "Use Exact thing",
        subtitle: "Fixture maker",
        badges: ["Exact identifier"],
      },
    ]);
    expect(JSON.stringify(choice)).not.toMatch(/"(selected|default|initial)"/);
    expect(rows[1]?.trailing).toBe("$12.50");
    expect(rows[1]?.lines?.map((entry) => entry.text)).toContain("sku: SKU-l1");
  });

  it("warns when several candidates match exactly", () => {
    const [block] = importReportBlocks(
      "run.import-prepared-orders",
      reviewing([
        order("o1", [
          line("l1", {
            candidates: [
              candidate("PRD-4K7M", "First", true),
              candidate("PRD-8H2N", "Second", true),
            ],
          }),
        ]),
      ]),
    );
    const only = block?.kind === "records" ? block.rows[1] : undefined;
    expect(only?.lines).toContainEqual({
      text: "Conflicting exact matches. Choose the Product to use.",
      tone: "warning",
    });
  });

  it("gives a purchase adjustment no choice and no demand", () => {
    const blocks = importReportBlocks(
      "run.import-prepared-orders",
      reviewing([
        order("o1", [line("l1", { requiresProductResolution: false })]),
      ]),
    );
    const adjustment = recordsOf(blocks).rows[1];
    expect(adjustment?.choice).toBeUndefined();
    expect(adjustment?.lines?.map((entry) => entry.text)).toContain(
      "Purchase adjustment · no Product selection",
    );
    const form = formOf(blocks);
    // No line needs a Product, so there is no trade to ask for and no decision to wait on.
    expect(form.choices).toEqual([]);
    expect(form.command.request).toMatchObject({
      kind: "commit-prepared",
      tradeChoiceId: null,
      lines: [],
    });
  });

  it("builds the approve command from the batch it belongs to, with a confirmation", () => {
    const blocks = importReportBlocks(
      "run.import-prepared-orders",
      reviewing([
        order("o1", [
          line("l1"),
          line("l2", { requiresProductResolution: false }),
        ]),
        order("o2", [line("l1")]),
        order("o3", [line("l1")], { prepareOperationId: "prepare-2" }),
      ]),
    );
    const batches = blocks.filter((block) => block.kind === "records");
    expect(batches).toHaveLength(2);
    const [first, second] = batches.map((block) => block.form);
    expect(first?.command).toMatchObject({
      label: "Approve and import",
      prominent: true,
      request: {
        kind: "commit-prepared",
        runId: RUN_ID,
        prepareOperationId: "prepare-1",
        tradeChoiceId: "trade",
        // The same stable line id in two orders stays two decisions.
        lines: [
          { choiceId: "o1/l1", stableOrderId: "o1", stableLineId: "l1" },
          { choiceId: "o2/l1", stableOrderId: "o2", stableLineId: "l1" },
        ],
      },
    });
    expect(first?.command.confirm).toMatch(/2 prepared orders/);
    expect(first?.command.confirm).toMatch(/Inventory is not changed/);
    expect(second?.command.request).toMatchObject({
      prepareOperationId: "prepare-2",
      lines: [{ choiceId: "o3/l1", stableOrderId: "o3", stableLineId: "l1" }],
    });
    expect(first?.choices).toHaveLength(1);
    expect(first?.choices[0]?.options.map((option) => option.id)).toContain(
      "other",
    );
    expect(first?.choices[0]).toMatchObject({
      id: "trade",
      label: "Trade for imported expenses",
      required: true,
    });
    expect(first).toMatchObject({
      noun: "Product decision",
      disabledReason: null,
      doneText: "Prepared import approved and committed.",
    });
  });

  it.each([
    [
      "a committed batch",
      { committed: true },
      {},
      "Prepared import approved and committed.",
    ],
    [
      "a stopped run",
      {},
      { status: "completed" as const },
      "Prepared orders can be approved only while an account sync run is running.",
    ],
    [
      "a validation run",
      {},
      { purpose: "purchase_validation" as const },
      "Prepared orders can be approved only while an account sync run is running.",
    ],
  ])(
    "offers no choices for %s and says why",
    (_name, orderChange, runChange, reason) => {
      const blocks = importReportBlocks(
        "run.import-prepared-orders",
        reviewing([order("o1", [line("l1")], orderChange)], runChange),
      );
      const block = recordsOf(blocks);
      expect(block.rows.every((row) => row.choice === undefined)).toBe(true);
      expect(block.form?.disabledReason).toBe(reason);
      expect(block.form?.choices).toEqual([]);
    },
  );
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
      status: "waiting" as const,
      searched: 40,
      skipped: 10,
      reviewable: 3,
      pagesScanned: 1,
      after: "1970/01/01",
      searchTerms: ["orders@fixture.test"],
      startedFromOlderPage: false,
      hasMorePages: true,
      retryAt: null,
      error: null,
    },
    discovery: null,
    orders: [{ orderId: "fixture-order", state: "pending" as const }],
    charges: [],
    workflow: {
      purpose: "mail_search" as const,
      attempt: 2,
      instanceId: `${RUN_ID}-2`,
      instance: { state: "waiting" as const, error: null },
    },
  };
  const actionsOf = (blocks: ReportBlock[]) =>
    blocks.flatMap((block) =>
      block.kind === "records"
        ? block.rows.flatMap((r) => r.commands ?? [])
        : [],
    );

  // Report composition must select the right Workflow and preserve retry attempts;
  // the browser cannot verify Cloudflare destinations without dashboard authentication.
  it.each([
    ["mail_search", "cubby-vendor-mail-search"],
    ["mail_discovery", "cubby-mail-discovery"],
  ] as const)(
    "deep-links %s to its current Workflow attempt",
    (purpose, name) => {
      const blocks = liveProgressBlocks(RUN_ID, {
        ...progress,
        workflow: { ...progress.workflow, purpose },
      });
      expect(recordsOf(blocks, "Workflow").rows[0]).toMatchObject({
        externalLink: {
          label: "Open in Cloudflare",
          url: `https://dash.cloudflare.com/9f10f078d35d86c78dedece2300a6b88/workers/workflows/${name}/instance/${RUN_ID}-2`,
        },
      });
      expect(
        liveProgressBlocks(RUN_ID, { ...progress, workflow: null }).some(
          (block) => block.kind === "records" && block.title === "Workflow",
        ),
      ).toBe(false);
    },
  );

  it("names the Workflow attempt and offers cancel while it runs, retry once failed", () => {
    const running = liveProgressBlocks(RUN_ID, progress);
    expect(notes(running)[0]).toBe("AI Gateway rate limited; waiting to retry");
    expect(recordsOf(running, "Workflow").rows[0]).toMatchObject({
      title: `Attempt 2 · ${RUN_ID}-2`,
      subtitle: "Workflow instance waiting",
    });
    expect(actionsOf(running).map((action) => action.request)).toEqual([
      {
        kind: "run-control",
        runId: RUN_ID,
        action: "cancel",
        operationId: null,
        approvalId: null,
      },
    ]);
    expect(
      actionsOf(
        liveProgressBlocks(RUN_ID, {
          ...progress,
          status: "failed",
          workflow: {
            ...progress.workflow,
            instance: { state: "missing", error: null },
          },
        }),
      ).map(
        (action) =>
          action.request.kind === "run-control" && action.request.action,
      ),
    ).toEqual(["retry"]);
    expect(
      actionsOf(
        liveProgressBlocks(RUN_ID, { ...progress, status: "completed" }),
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
        transport: "chatgpt" as const,
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
    expect(call?.statuses).toEqual([
      { label: "succeeded", tone: "positive" },
      { label: "ChatGPT plan" },
    ]);
    expect(call?.lines?.map((l) => l.text)).toEqual([
      "fixture-model · attempt 1",
      "100 in / — out",
      // `cacheStatus` is the caller's cache (an analysis or prompt cache),
      // never a claim that the Gateway carried the call.
      "Application hit · no model call · Cache miss · 5 read / — write",
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
