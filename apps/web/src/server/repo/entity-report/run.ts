import { targetOutcomeSummary } from "@cubby/schemas/activity";
import type { AiRunUsage } from "@cubby/schemas/ai";
import type { AuditJsonValue, AuditLogListOut } from "@cubby/schemas/audit";
import type {
  ReportChoice,
  ReportCommand,
  ReportBlock,
} from "@cubby/schemas/entity-report";
import {
  countRunTargets,
  runTargetState,
} from "@cubby/schemas/purchase-import";
import { hasImportRunReports } from "@cubby/schemas/run-fields";
import { TRADE_LABELS, tradeValues } from "@cubby/schemas/task-fields";
import { AI_USAGE_TRANSPORT_LABELS } from "@cubby/schemas/telemetry";
import { CF_ACCOUNT_ID } from "@cubby/shared/ai/gateway-metadata";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { z } from "zod";

import type { RunDetail, RunLogEntry } from "~/contracts/run.contract";
import { formatInstant } from "~/lib/date-format";
import { formatDuration } from "~/lib/format-duration";
import { formatAiCost, formatAiCostSubtotal } from "~/lib/number-format";
import { formatCurrency, formatPercent } from "~/lib/number-format";
import { runHasCapability } from "~/server/purchase-import/capabilities";
import { phaseLabel, runRowState } from "~/server/repo/collection-items";
import type { getRunLiveProgress } from "~/server/repo/run-progress";
import type { suggestionCounts } from "~/server/repo/suggestion-review";

/**
 * The Run detail's report blocks: progress, approvals, findings, transcript, log, AI usage and
 * changes, composed once for web and native. Every sentence, empty-state line, visibility rule
 * and action below is written here; a client lays the blocks out. A report that does not apply
 * to the run (the other progress variant, targets a run never had) is no blocks, so the client
 * hides its section. The builders are pure over declared dependency results.
 */

type RunLiveProgress = NonNullable<
  Awaited<ReturnType<typeof getRunLiveProgress>>
>;
type Block<Kind extends ReportBlock["kind"]> = Extract<
  ReportBlock,
  { kind: Kind }
>;
type Row = Block<"records">["rows"][number];
type Tone = NonNullable<NonNullable<Row["badges"]>[number]["tone"]>;
type Line = NonNullable<Row["lines"]>[number];

/** What a run builder says about one record row; `row` lays it out as the shared row shape. */
interface RowFields {
  state?: Row["state"];
  title?: string | undefined;
  body?: string | undefined;
  trailing?: string | undefined;
  at?: string | undefined;
  badges?: Array<{ label: string; tone?: Tone | undefined }>;
  lines?: Line[];
  ref?: { entity: string; id: string } | undefined;
  detail?: { label: string; text: string } | undefined;
  actions?: ReportCommand[];
  externalLink?: Row["externalLink"];
}

const LIVE_STATUSES: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUSES);

/** A run that is still moving: clients poll and offer controls only while this holds. */
export const isLiveRunStatus = (status: string): boolean =>
  LIVE_STATUSES.has(status);

const toneForState = (state: string): Tone | undefined => {
  if (state === "completed") return "positive";
  if (state === "failed" || state === "cancelled" || state === "aborted")
    return "destructive";
  if (state.startsWith("paused")) return "warning";
  return undefined;
};

/**
 * A status with a settled meaning is the row's state, so a failed phase reads as one and its
 * detail wraps in full instead of clipping (a ledger clips only quiet rows).
 */
const statusState = (status: string, label = phaseLabel(status)) => {
  const kind = runRowState(status);
  return kind ? { kind, label } : undefined;
};

const line = (text: string, tone?: Tone): Line =>
  tone ? { text, tone } : { text };

const badge = (label: string, tone?: Tone) =>
  tone ? { label, tone } : { label };

/** A record row of the shared `records` block; `id` is its stable key. */
const row = (id: string, fields: RowFields = {}): Row => ({
  entity: fields.ref?.entity ?? null,
  id: fields.ref?.id ?? null,
  title: fields.title ?? "",
  trailing: fields.trailing ?? null,
  key: id,
  at: fields.at,
  ...(fields.state ? { state: fields.state } : {}),
  badges: fields.badges ?? [],
  // The body's first line is the row's result; the rest is evidence.
  lines: [
    ...(fields.body ?? "")
      .split("\n")
      .filter((text) => text !== "")
      .map((text, index) => line(text, index === 0 ? undefined : "muted")),
    ...(fields.lines ?? []),
  ],
  detail: fields.detail,
  commands: fields.actions ?? [],
  externalLink: fields.externalLink,
});

/** `empty` is the copy for no rows; an empty string hides the block. */
const records = (
  rows: Row[],
  fields: {
    title?: string;
    empty?: string;
    presentation?: Block<"records">["presentation"];
  } = {},
): Block<"records"> => ({
  kind: "records",
  title: fields.title,
  rows,
  empty: fields.empty ?? "",
  presentation: fields.presentation,
});

const counts = (
  figures: ReadonlyArray<readonly [label: string, value: number]>,
): Block<"stats"> => ({
  kind: "stats",
  figures: figures.map(([label, value]) => ({
    label,
    value,
    format: "count" as const,
  })),
});

const note = (text: string, tone?: Tone, strong?: boolean): Block<"note"> => ({
  kind: "note",
  text,
  tone,
  strong,
});

const minutesSeconds = (seconds: number) =>
  `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

const memberName = (member: RunDetail["actor"]) =>
  member.name ?? member.ledgerParty?.name ?? "Household member";

const decision = (
  runId: RunDetail["publicId"],
  approval: RunDetail["approvals"][number],
  action: "approve" | "reject",
): ReportCommand => ({
  id: `${approval.id}:${action}`,
  label:
    action === "approve" ? "Approve import proposal" : "Reject import proposal",
  prominent: action === "approve",
  confirm:
    action === "approve"
      ? `Approve ${approval.operationKind}? The agent will run it with the arguments shown.`
      : `Reject ${approval.operationKind}? The agent will not run it.`,
  request: {
    kind: "run-control",
    runId,
    action,
    operationId: approval.operationId,
    approvalId: approval.id,
  },
});

const targetCounts = (run: RunDetail) =>
  countRunTargets(
    run.targets.map((target) => runTargetState.parse(target.state)),
  );

const researchOutcomes = new Set([
  "verified",
  "partially_verified",
  "researched_with_gaps",
  "ambiguous",
  "temporarily_blocked",
  "no_source_found",
  "unrelated",
]);

const isResearchRun = (run: RunDetail) =>
  run.targets.some(
    (target) => target.outcome && researchOutcomes.has(target.outcome),
  ) || run.purpose === "product_enrichment";
const researchCounts = (run: RunDetail) => ({
  total: run.targets.length,
  verified: run.targets.filter((target) => target.outcome === "verified")
    .length,
  gaps: run.targets.filter(
    (target) =>
      target.outcome !== "verified" &&
      ["completed", "skipped", "unresolved", "unavailable"].includes(
        target.state,
      ),
  ).length,
  pending: run.targets.filter(
    (target) =>
      target.state === "pending" ||
      target.state === "prepared" ||
      target.state === "needs_evidence",
  ).length,
});
const researchSummary = (run: RunDetail) => {
  const tally = researchCounts(run);
  return [
    `${tally.verified}/${tally.total} verified`,
    tally.gaps ? `${tally.gaps} with gaps` : null,
    tally.pending ? `${tally.pending} to go` : null,
  ]
    .filter(Boolean)
    .join(" · ");
};
const targetBadge = (
  target: RunDetail["targets"][number],
  research: boolean,
) =>
  target.outcome && researchOutcomes.has(target.outcome)
    ? badge(
        phaseLabel(target.outcome),
        target.outcome === "verified" ? "positive" : "warning",
      )
    : research
      ? badge(
          phaseLabel(target.outcome ?? target.state),
          ["completed", "skipped", "unresolved", "unavailable"].includes(
            target.state,
          )
            ? "warning"
            : undefined,
        )
      : badge(target.state, toneForState(target.state));

/** Counts in the unit the run works in: Products for enrichment, orders otherwise. */
const importStats = (run: RunDetail): ReportBlock[] => {
  if (!isResearchRun(run))
    return [
      counts([
        ["Orders seen", run.ordersSeen],
        ["Imported", run.imported],
        ["Updated", run.updated],
        ["Skipped", run.skipped],
      ]),
    ];
  const tally = researchCounts(run);
  return [
    counts([
      ["Targets", tally.total],
      ["Verified", tally.verified],
      ["With gaps", tally.gaps],
      ["To go", tally.pending],
    ]),
  ];
};

function importProgress(run: RunDetail): ReportBlock[] {
  const latest = run.latestProgress;
  const blocks: ReportBlock[] = [
    note(
      latest
        ? `${latest.phase}${latest.detail ? ` · ${latest.detail}` : ""}`
        : "No progress updates have been recorded.",
    ),
  ];
  if (run.controllingMembers.length)
    blocks.push(
      note(
        `Controlled by ${run.controllingMembers.map(memberName).join(", ")}.`,
      ),
    );
  if (run.controlHistory.length)
    blocks.push(
      records(
        run.controlHistory.map((event) =>
          row(`${event.action}-${event.createdAt}`, {
            title: `${memberName(event)} ${event.action.replaceAll("_", " ")}`,
            at: event.createdAt,
          }),
        ),
        { title: "Control history" },
      ),
    );
  if (run.progress.length)
    blocks.push(
      records(
        [...run.progress].reverse().map((progress) =>
          row(progress.eventId, {
            title: `${progress.phase}${progress.currentItem ? ` · ${progress.currentItem}` : ""}${progress.detail ? ` · ${progress.detail}` : ""}`,
            at: progress.createdAt,
            state: statusState(progress.phase),
          }),
        ),
        { title: "Run progress history", presentation: "timeline" },
      ),
    );
  return blocks;
}

const importPurchases = (run: RunDetail): ReportBlock[] => [
  records(
    run.affectedPurchases.map((purchase) =>
      row(purchase.shortcode, {
        title: purchase.displayName ?? purchase.orderId ?? purchase.shortcode,
        ref: { entity: "purchase", id: purchase.shortcode },
      }),
    ),
    { empty: "No purchases were changed by this run." },
  ),
];

const importApprovals = (run: RunDetail): ReportBlock[] => [
  records(
    run.approvals.map((approval) => {
      const decided = approval.rejectedAt ?? approval.grantedAt;
      const statusLine = approval.rejectedAt
        ? line("Rejected")
        : approval.grantedAt
          ? line("Granted")
          : line("Awaiting explicit approval", "warning");
      return row(approval.id, {
        title: approval.operationKind,
        badges: [badge(approval.state, toneForState(approval.state))],
        at: decided ?? undefined,
        lines: [statusLine, line(approval.operationId, "muted")],
        detail: {
          label: "Proposed arguments",
          text: JSON.stringify(approval.args, null, 2),
        },
        actions:
          approval.state === "pending"
            ? [
                decision(run.publicId, approval, "approve"),
                decision(run.publicId, approval, "reject"),
              ]
            : [],
      });
    }),
    { empty: "No approvals were required for this run." },
  ),
];

function findingFix(finding: RunDetail["findings"][number]) {
  const fix = finding.proposedFix;
  const lines: Line[] = [];
  if (fix === null || fix.kind === "receive_purchase")
    return { lines, applyConfirm: null };
  if (fix.kind === "reconcile_source_order") {
    if (!fix.review) {
      lines.push(
        line("Review the source-order reconciliation before applying it."),
      );
      return { lines, applyConfirm: null };
    }
    const review = fix.review;
    lines.push(
      line(
        `Reviewed spend: ${formatCurrency(review.spend.before ?? 0)} → ${formatCurrency(review.spend.after ?? 0)}`,
      ),
    );
    for (const expense of review.expenses)
      lines.push(
        line(`${expense.title} · ${formatCurrency(expense.amount ?? 0)}`),
      );
    return {
      lines,
      applyConfirm: "Apply this reviewed source-order reconciliation?",
    };
  }
  if (fix.kind !== "replace_aggregate_line")
    return { lines, applyConfirm: "Apply this correction to your records?" };
  const snapshot = fix.reviewSnapshot;
  if (!snapshot) {
    lines.push(
      line(
        "Receipt replacement needs a fresh server review before it can be applied.",
      ),
    );
    return { lines, applyConfirm: null };
  }
  lines.push(
    line(
      `Replace ${snapshot.title} (${formatCurrency(snapshot.amount)}) with the receipt lines below.`,
    ),
  );
  const meta = [
    snapshot.date,
    snapshot.projectName,
    snapshot.categoryName,
    snapshot.costType,
    snapshot.trade,
    snapshot.notes,
  ].filter(Boolean);
  if (meta.length) lines.push(line(meta.join(" · "), "muted"));
  for (const replacement of fix.lines)
    lines.push(
      line(`${replacement.title} · ${formatCurrency(replacement.amount ?? 0)}`),
    );
  for (const share of fix.reviewedLineAttributions ?? [])
    lines.push(
      line(
        `Line ${share.lineIndex + 1} · ${share.role} · ${share.partyCode} · ${formatCurrency(share.amount)}`,
        "muted",
      ),
    );
  return {
    lines,
    applyConfirm: `Replace ${snapshot.title} (${formatCurrency(snapshot.amount)}) with the receipt lines shown? This changes the ledger.`,
  };
}

/** Apply (when the fix is reviewable) and dismiss, for a finding still open. */
function findingActions(
  finding: RunDetail["findings"][number],
  applyConfirm: string | null,
): ReportCommand[] {
  if (finding.status !== "open") return [];
  const reviewedFingerprint =
    finding.proposedFix?.kind === "replace_aggregate_line"
      ? (finding.proposedFix.reviewSnapshot?.fingerprint ?? null)
      : finding.proposedFix?.kind === "reconcile_source_order"
        ? (finding.proposedFix.review?.reviewedFingerprint ?? null)
        : null;
  const apply: ReportCommand[] =
    applyConfirm === null
      ? []
      : [
          {
            id: `${finding.id}:apply`,
            label: "Apply fix",
            prominent: true,
            confirm: applyConfirm,
            request: {
              kind: "resolve-finding",
              findingId: finding.id,
              decision: "apply",
              reviewedFingerprint,
            },
          },
        ];
  return [
    ...apply,
    {
      id: `${finding.id}:dismiss`,
      label: "Dismiss",
      prominent: false,
      confirm: null,
      request: {
        kind: "resolve-finding",
        findingId: finding.id,
        decision: "dismiss",
        reviewedFingerprint: null,
      },
    },
  ];
}

const importFindings = (run: RunDetail): ReportBlock[] => [
  records(
    run.findings.map((finding) => {
      const { lines, applyConfirm } =
        finding.status === "open"
          ? findingFix(finding)
          : { lines: [], applyConfirm: null };
      if (finding.probability != null)
        lines.push(
          line(
            `Probability ${formatPercent(finding.probability, { maximumFractionDigits: 0 })}`,
            "muted",
          ),
        );
      if (finding.expiresAt)
        lines.push(
          line(
            `Expires ${formatInstant(finding.expiresAt, "dateShortTime")}`,
            "muted",
          ),
        );
      return row(finding.id, {
        title: finding.kind,
        body: finding.summary,
        at: finding.createdAt,
        badges: [
          badge(finding.status, toneForState(finding.status)),
          ...(finding.autoApplied ? [badge("auto-applied", "muted")] : []),
        ],
        lines,
        actions: findingActions(finding, applyConfirm),
      });
    }),
    { empty: "No findings were recorded for this run." },
  ),
];

const importTargets = (run: RunDetail): ReportBlock[] =>
  run.targets.length === 0
    ? []
    : [
        note(
          (isResearchRun(run)
            ? researchSummary(run)
            : targetOutcomeSummary(targetCounts(run))) ??
            "The selected source and target are frozen for this run.",
        ),
        records(
          run.targets.map((target) =>
            row(target.id, {
              title:
                target.targetName ??
                target.targetShortcode ??
                target.targetType,
              badges: [targetBadge(target, isResearchRun(run))],
              lines: [
                line(
                  `${target.sourceLabel ?? "No source selected"}${target.vendorAccountLabel ? ` · ${target.vendorAccountLabel}` : ""}`,
                  "muted",
                ),
                ...(target.outcome ? [line(`Outcome: ${target.outcome}`)] : []),
                ...(target.warning ? [line(target.warning, "warning")] : []),
              ],
              detail:
                target.diff === null
                  ? undefined
                  : {
                      label: "Recorded difference",
                      text: JSON.stringify(target.diff, null, 2),
                    },
              ref: target.targetShortcode
                ? { entity: target.targetType, id: target.targetShortcode }
                : undefined,
            }),
          ),
          { empty: "No explicit targets were recorded for this run." },
        ),
      ];

const importTimeline = (run: RunDetail): ReportBlock[] => [
  records(
    run.operations.map((operation) => {
      const state = statusState(operation.state, operation.state);
      return row(operation.operationId, {
        title: operation.kind,
        at: operation.startedAt,
        state,
        // A state with no mark keeps its own word as a chip.
        badges: state ? [] : [badge(operation.state)],
        lines: [
          line(operation.operationId, "muted"),
          ...(operation.error ? [line(operation.error, "destructive")] : []),
        ],
      });
    }),
    { empty: "No durable operations have been recorded for this run." },
  ),
];

type PreparedOrder = RunDetail["preparedOrders"][number];
type PreparedLine = PreparedOrder["lines"][number];

const COMMITTED = "Prepared import approved and committed.";
const APPROVE_BLOCKED =
  "Prepared orders can be approved only while their import run is running.";
const TRADE_CHOICE_ID = "trade";

/** One decision per line; the id joins the ids' own character set, which excludes "/". */
const lineChoiceId = (order: PreparedOrder, prepared: PreparedLine) =>
  `${order.stableOrderId}/${prepared.stableLineId}`;

/**
 * The decision a prepared line asks for. Nothing is preselected, even for a single exact
 * identifier match: identity is chosen by the person, and the candidates only rank the options.
 */
function productChoice(id: string, prepared: PreparedLine): ReportChoice {
  return {
    id,
    label: `Product decision for ${prepared.title}`,
    required: true,
    options: [
      {
        id: "existing",
        label: "Use an existing Product",
        pick: { entity: "product", label: `Product for ${prepared.title}` },
      },
      {
        id: "new",
        label: "Create a new Product",
        hint: "A new Product will use this prepared line’s title and identifiers.",
      },
      {
        id: "unresolved",
        label: "Leave Product unresolved",
        text: { label: `Reason for leaving ${prepared.title} unresolved` },
      },
      {
        id: "expense_only",
        label: "Record as an expense only",
        hint: "For a meal, ticket, ride, subscription, donation, or service: no Product is created.",
      },
    ],
    suggestions: prepared.candidates.map((candidate) => {
      const subtitle = [
        candidate.manufacturer,
        candidate.model,
        candidate.matchReason,
      ]
        .filter(Boolean)
        .join(" · ");
      const suggestion: NonNullable<ReportChoice["suggestions"]>[number] = {
        optionId: "existing",
        entity: "product",
        id: candidate.productId,
        name: candidate.name,
        label: `Use ${candidate.name}`,
        badges: [
          ...(candidate.exactIdentifierMatch ? ["Exact identifier"] : []),
          ...(candidate.exactNameMatch ? ["Exact name"] : []),
        ],
      };
      if (subtitle) suggestion.subtitle = subtitle;
      return suggestion;
    }),
  };
}

function preparedLineRow(
  order: PreparedOrder,
  prepared: PreparedLine,
  decidable: boolean,
): Row {
  const exactCount = prepared.candidates.filter(
    (candidate) => candidate.exactIdentifierMatch,
  ).length;
  const lines = [
    ...Object.entries(prepared.identifiers).map(([key, value]) =>
      line(`${key}: ${value}`, "muted"),
    ),
    ...(!prepared.requiresProductResolution
      ? [line("Purchase adjustment · no Product selection", "muted")]
      : decidable && exactCount > 1
        ? [
            line(
              "Conflicting exact matches. Choose the Product to use.",
              "warning",
            ),
          ]
        : []),
  ];
  const built: Row = {
    ...row(`line:${order.stableOrderId}:${prepared.stableLineId}`, {
      title: prepared.title,
      lines,
    }),
    trailing: formatCurrency(prepared.amount),
  };
  if (decidable && prepared.requiresProductResolution)
    built.choice = productChoice(lineChoiceId(order, prepared), prepared);
  return built;
}

function preparedBatch(
  run: RunDetail,
  prepareOperationId: string,
  orders: PreparedOrder[],
  title: string | undefined,
): Block<"records"> {
  const committed = orders.every((order) => order.committed);
  const blocked =
    run.status !== "running" ||
    !runHasCapability(run.purpose, "commit_purchase_import");
  const disabledReason = committed
    ? COMMITTED
    : blocked
      ? APPROVE_BLOCKED
      : null;
  const decidable = disabledReason === null;
  const required = orders.flatMap((order) =>
    order.lines
      .filter((prepared) => prepared.requiresProductResolution)
      .map((prepared) => ({ order, prepared })),
  );
  const lineCount = orders.reduce((sum, order) => sum + order.lines.length, 0);
  const rows = orders.flatMap((order) => [
    {
      ...row(`order:${order.stableOrderId}`, {
        title: `${order.sourceKind} · ${order.externalKey ?? order.stableOrderId}`,
      }),
      trailing: `${order.lineCount} lines`,
    },
    ...order.lines.map((prepared) =>
      preparedLineRow(order, prepared, decidable),
    ),
  ]);
  const orderWord = orders.length === 1 ? "order" : "orders";
  return {
    ...records(rows, { title }),
    form: {
      choices:
        decidable && required.length > 0
          ? [
              {
                id: TRADE_CHOICE_ID,
                label: "Trade for imported expenses",
                required: true,
                options: tradeValues.map((value) => ({
                  id: value,
                  label: TRADE_LABELS[value],
                })),
              },
            ]
          : [],
      note: "Approval imports the prepared orders and expenses.",
      noun: "Product decision",
      completeText: "All Product decisions reviewed.",
      disabledReason,
      doneText: COMMITTED,
      command: {
        id: `commit:${prepareOperationId}`,
        label: "Approve and import",
        prominent: true,
        confirm: `Import ${orders.length} prepared ${orderWord} (${lineCount} lines) as purchases and expenses? Inventory is not changed.`,
        request: {
          kind: "commit-prepared",
          runId: run.publicId,
          prepareOperationId,
          tradeChoiceId: required.length > 0 ? TRADE_CHOICE_ID : null,
          lines: required.map(({ order, prepared }) => ({
            choiceId: lineChoiceId(order, prepared),
            stableOrderId: order.stableOrderId,
            stableLineId: prepared.stableLineId,
          })),
        },
      },
    },
  };
}

/** Prepared orders grouped by the batch that prepared them, each reviewed and approved alone. */
function importPreparedOrders(run: RunDetail): ReportBlock[] {
  const batches = new Map<string, PreparedOrder[]>();
  for (const order of run.preparedOrders)
    batches.set(order.prepareOperationId, [
      ...(batches.get(order.prepareOperationId) ?? []),
      order,
    ]);
  if (batches.size === 0) return [note("No orders were prepared.")];
  return [...batches].map(([id, orders], index) =>
    preparedBatch(
      run,
      id,
      orders,
      batches.size > 1 ? `Prepared batch ${index + 1}` : undefined,
    ),
  );
}

/** The import-workflow slots built from the run detail alone. */
const IMPORT_BUILDERS = {
  "run.import-stats": importStats,
  "run.import-progress-live": (run: RunDetail) =>
    isLiveRunStatus(run.status) ? importProgress(run) : [],
  "run.import-progress-stopped": (run: RunDetail) =>
    isLiveRunStatus(run.status) ? [] : importProgress(run),
  "run.import-purchases": importPurchases,
  "run.import-approvals": importApprovals,
  "run.import-findings": importFindings,
  "run.import-targets": importTargets,
  "run.import-prepared-orders": importPreparedOrders,
  "run.import-timeline": importTimeline,
} as const satisfies Record<string, (run: RunDetail) => ReportBlock[]>;
export type ImportReportSlot = keyof typeof IMPORT_BUILDERS;

/**
 * Durable operations are evidence for every Run purpose. Other import slots
 * remain restricted to workflows that use the purchase-import reports.
 */
export function importReportBlocks(
  slot: ImportReportSlot,
  run: RunDetail,
): ReportBlock[] {
  if (slot === "run.import-timeline") return importTimeline(run);
  return hasImportRunReports(run.purpose) ? IMPORT_BUILDERS[slot](run) : [];
}

/** The status sentence over the progress rows: what the run is doing, or how it ended. */
function progressHeadline(progress: RunLiveProgress): string {
  const active = progress.status === "running";
  const last = progress.progress.at(-1);
  if (active) return last?.detail ?? "Working…";
  if (progress.status === "completed")
    return progress.discovery?.routine ? "Nothing new" : "Run completed";
  if (progress.status === "failed") return "Run failed";
  return phaseLabel(progress.status);
}

/** How long the run has gone quiet, while it is live. */
function progressAge(progress: RunLiveProgress): string | null {
  if (progress.status !== "running") return null;
  const last = progress.progress.at(-1);
  return last && last.ageSeconds > 10
    ? `Last update ${minutesSeconds(last.ageSeconds)} ago`
    : "Updating live";
}

/**
 * The Workflow behind a Gmail Run: its current attempt as Cloudflare reports
 * it, with cancel while it runs and retry once it failed. A retry starts a
 * new attempt that resumes from the Run's saved progress.
 */
function workflowBlocks(
  runId: RunDetail["publicId"],
  progress: RunLiveProgress,
): ReportBlock[] {
  const workflow = progress.workflow;
  if (!workflow) return [];
  const instance = workflow.instance
    ? workflow.instance.state === "missing"
      ? "no longer retained by Cloudflare"
      : phaseLabel(workflow.instance.state).toLowerCase()
    : "status unavailable";
  const actions: ReportCommand[] =
    progress.status === "running"
      ? [
          {
            id: "cancel",
            label: "Cancel run",
            prominent: false,
            confirm: "Cancel this Run? Work already saved stays saved.",
            request: {
              kind: "run-control",
              runId,
              action: "cancel",
              operationId: null,
              approvalId: null,
            },
          },
        ]
      : progress.status === "failed"
        ? [
            {
              id: "retry",
              label: "Retry run",
              prominent: true,
              confirm: null,
              request: {
                kind: "run-control",
                runId,
                action: "retry",
                operationId: null,
                approvalId: null,
              },
            },
          ]
        : [];
  return [
    records(
      [
        row("workflow", {
          externalLink: {
            label: "Open in Cloudflare",
            url: `https://dash.cloudflare.com/${CF_ACCOUNT_ID}/workers/workflows/cubby-mail-discovery/instance/${encodeURIComponent(workflow.instanceId)}`,
          },
          title: `Attempt ${workflow.attempt} · ${workflow.instanceId}`,
          body: `Workflow instance ${instance}${workflow.instance?.error ? `: ${workflow.instance.error}` : ""}`,
          actions,
        }),
      ],
      { title: "Workflow" },
    ),
  ];
}

type DiscoveryProgress = NonNullable<RunLiveProgress["discovery"]>;

function discoveryCountsBlock(
  discovery: DiscoveryProgress,
  active: boolean,
): ReportBlock {
  const sentence = (id: string, text: string) => row(id, { title: text });
  return records([
    ...(active
      ? [
          sentence(
            "pages",
            `${discovery.pagesDone} mailbox ${discovery.pagesDone === 1 ? "page" : "pages"} processed`,
          ),
        ]
      : []),
    sentence(
      "saved",
      `${discovery.saved} ${discovery.saved === 1 ? "message" : "messages"} saved`,
    ),
    sentence("events", `${discovery.events} history changes recorded`),
    ...(discovery.unrelated
      ? [
          sentence(
            "unrelated",
            `${discovery.unrelated} messages unrelated to purchases`,
          ),
        ]
      : []),
    ...(discovery.excluded
      ? [
          sentence(
            "excluded",
            `${discovery.excluded} Spam or Trash messages excluded`,
          ),
        ]
      : []),
    ...(discovery.deleted
      ? [sentence("deleted", `${discovery.deleted} deleted before fetching`)]
      : []),
    ...(discovery.droppedEvents
      ? [
          sentence(
            "dropped",
            `${discovery.droppedEvents} changes about mail Cubby never saved`,
          ),
        ]
      : []),
  ]);
}

/** The selected orders and charges a targeted mail or charge-search run works through. */
/** Durable progress for every Run, including work done outside the page that opened it. */
export function liveProgressBlocks(
  runId: RunDetail["publicId"],
  progress: RunLiveProgress,
): ReportBlock[] {
  const active = progress.status === "running";
  const age = progressAge(progress);
  return [
    note(progressHeadline(progress), undefined, true),
    ...(age ? [note(age)] : []),
    ...workflowBlocks(runId, progress),
    ...(progress.discovery
      ? [discoveryCountsBlock(progress.discovery, active)]
      : []),
    records(
      progress.progress.map((event) =>
        row(event.id, {
          title: phaseLabel(event.phase),
          body: event.detail ?? undefined,
          at: event.createdAt,
          state: statusState(event.phase),
        }),
      ),
      {
        empty: active
          ? "Waiting for the first progress update…"
          : "No progress updates were recorded for this Run.",
        presentation: "timeline",
      },
    ),
  ];
}

/** Server tool calls and Mac bridge events, oldest first. */
export function runLogBlocks(log: {
  entries: readonly RunLogEntry[];
  truncated: boolean;
}): ReportBlock[] {
  return [
    records(
      log.entries.map((entry) =>
        row(entry.id, {
          title: entry.event,
          at: entry.occurredAt,
          ...(entry.level === "error"
            ? { state: { kind: "failed" as const, label: "Error" } }
            : {}),
          lines: [
            line(entry.source, "muted"),
            ...(entry.error ? [line(entry.error, "destructive")] : []),
          ],
        }),
      ),
      { empty: "No structured log entries were recorded." },
    ),
    ...(log.truncated
      ? [note("This view is limited to the first 2,000 events.", "warning")]
      : []),
  ];
}

/** A sweep Run's stored Suggestion outcomes; review happens on web `/ai` or over MCP. */
export function suggestionBlocks(
  counts: Awaited<ReturnType<typeof suggestionCounts>>,
): ReportBlock[] {
  const total = (key: "pending" | "applied" | "rejected" | "superseded") =>
    counts.reduce((sum, row) => sum + row[key], 0);
  const figure = (label: string, value: number) => ({
    label,
    value,
    format: "count" as const,
  });
  return [
    {
      kind: "stats",
      figures: [
        figure("Pending", total("pending")),
        figure("Accepted", total("applied")),
        figure("Rejected", total("rejected")),
        figure("Superseded", total("superseded")),
      ],
    },
  ];
}

type AiCall = AiRunUsage["records"][number];

const sum = (calls: readonly AiCall[], read: (call: AiCall) => number | null) =>
  calls.reduce((total, call) => total + (read(call) ?? 0), 0);

/** A token total; unknown when no call reported one, never zero. */
const tokens = (
  calls: readonly AiCall[],
  read: (call: AiCall) => number | null,
) =>
  calls.every((call) => read(call) == null) ? "—" : String(sum(calls, read));

/** One call's evidence, a line of a group's detail. */
const aiCallText = (call: AiCall) =>
  [
    formatInstant(call.createdAt, "time"),
    `attempt ${call.attempt}`,
    `${call.inputTokens ?? "—"} in / ${call.outputTokens ?? "—"} out`,
    call.applicationCacheStatus === "hit"
      ? "Application hit · no model call"
      : `Application ${call.applicationCacheStatus ?? "—"}`,
    `Cache ${call.cacheStatus ?? "—"} · ${call.cacheReadTokens ?? "—"} read / ${call.cacheWriteTokens ?? "—"} write`,
    call.durationMs == null ? "—" : formatDuration(call.durationMs),
    `Charged ${formatAiCost(call.chargedCost)}`,
    `Standard ${formatAiCost(call.standardCost)}`,
    call.costEvidence?.billingReason ?? "unknown",
    ...(call.gatewayLogId ? [call.gatewayLogId] : []),
  ].join(" · ");

/**
 * Every AI call the run made, one row per operation, model, transport and outcome: a sweep makes
 * the same call hundreds of times, so each call is a line of its group's detail.
 */
export function aiUsageBlocks(usage: AiRunUsage): ReportBlock[] {
  const groups = new Map<string, AiCall[]>();
  for (const call of usage.records) {
    const key = [
      call.operation,
      call.feature,
      call.provider,
      call.model,
      call.transport,
      call.status,
    ].join("|");
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }
  const text = (label: string, value: string) => ({
    label,
    value: null,
    format: "text" as const,
    text: value,
  });
  return [
    // A run that made no calls has no totals to state, only its empty copy.
    ...(usage.count === 0
      ? []
      : [
          {
            kind: "stats" as const,
            figures: [
              text(
                "Charged",
                formatAiCostSubtotal(
                  usage.chargedCost,
                  usage.chargedUnpricedCount,
                  usage.count,
                  usage.chargedComplete,
                ),
              ),
              text(
                "Standard",
                formatAiCostSubtotal(
                  usage.standardCost,
                  usage.standardUnpricedCount,
                  usage.count,
                  usage.standardComplete,
                ),
              ),
              text(
                "Savings",
                usage.comparedCalls === 0
                  ? "unavailable"
                  : `${formatAiCost(usage.savings)} · ${usage.comparedCalls}/${usage.count} compared`,
              ),
            ],
          },
        ]),
    records(
      [...groups].map(([key, calls]) => {
        const [first] = calls;
        if (!first) throw new Error("An AI usage group has no calls.");
        const unpriced = calls.filter((call) => call.chargedCost == null);
        return row(key, {
          title: `${first.operation} · ${first.feature} · ${first.provider}`,
          at: first.createdAt.toISOString(),
          state: {
            kind: first.status === "succeeded" ? "done" : "failed",
            label: first.status,
          },
          trailing:
            unpriced.length === calls.length
              ? "unpriced"
              : formatAiCostSubtotal(
                  sum(calls, (call) => call.chargedCost),
                  unpriced.length,
                ),
          lines: [
            line(
              `${tokens(calls, (call) => call.inputTokens)} in / ${tokens(calls, (call) => call.outputTokens)} out`,
            ),
            line(
              `${calls.length === 1 ? "1 call" : `${calls.length} calls`} · ${first.model} · ${AI_USAGE_TRANSPORT_LABELS[first.transport]}`,
              "muted",
            ),
          ],
          detail: {
            label: calls.length === 1 ? "Call" : "Calls",
            text: calls.map(aiCallText).join("\n"),
          },
        });
      }),
      { empty: "No AI calls were recorded for this run." },
    ),
  ];
}

const AUDIT_VERB = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
} as const;

/** How many changed fields one audit entry lists before summarizing the rest. */
const MAX_CHANGE_LINES = 6;

const changeText = (value: AuditJsonValue | undefined): string => {
  if (value === null || value === undefined || value === "") return "(empty)";
  const plain = z.union([z.string(), z.number(), z.boolean()]).safeParse(value);
  const text = plain.success ? String(plain.data) : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/** Every audit entry the run wrote. */
export function changesBlocks(list: AuditLogListOut): ReportBlock[] {
  return [
    records(
      list.entries.map((entry) => {
        const changes = Object.entries(entry.changes ?? {});
        return row(entry.entryKey, {
          title: `${AUDIT_VERB[entry.action]} ${entry.entityKind}${entry.entityName ? ` · ${entry.entityName}` : ""}`,
          at: entry.createdAt.toISOString(),
          badges: [badge(entry.channel, "muted")],
          ref:
            entry.entityId && entry.action !== "delete"
              ? { entity: entry.entityKind, id: entry.entityId }
              : undefined,
          lines: [
            ...changes
              .slice(0, MAX_CHANGE_LINES)
              .map(([field, change]) =>
                line(
                  `${field}: ${changeText(change.from)} → ${changeText(change.to)}`,
                  "muted",
                ),
              ),
            ...(changes.length > MAX_CHANGE_LINES
              ? [
                  line(
                    `+${changes.length - MAX_CHANGE_LINES} more fields`,
                    "muted",
                  ),
                ]
              : []),
          ],
        });
      }),
      { empty: "This run has not written any records." },
    ),
  ];
}

/** The run report slots (`run.*` in `reportSlots`). */
export type RunReportSlot =
  | ImportReportSlot
  | "run.live-progress"
  | "run.import-debug-log"
  | "run.ai-usage"
  | "run.suggestions"
  | "run.changes";

export const isImportReportSlot = (slot: string): slot is ImportReportSlot =>
  Object.hasOwn(IMPORT_BUILDERS, slot);
