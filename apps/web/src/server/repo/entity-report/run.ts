import type { AiRunUsage } from "@cubby/schemas/ai";
import type { AuditJsonValue, AuditLogListOut } from "@cubby/schemas/audit";
import type {
  EntityReportOut,
  ReportChoice,
  ReportCommand,
  ReportBlock,
} from "@cubby/schemas/entity-report";
import { runStatus } from "@cubby/schemas/run-fields";
import { TRADE_LABELS, tradeValues } from "@cubby/schemas/task-fields";
import {
  ACTIVE_RUN_STATUSES,
  HOUSEHOLD_TIMEZONE,
  IMPORT_WORKFLOW_PURPOSES,
} from "@cubby/shared/client-constants";
import { z } from "zod";

import type { RunDetail, RunLogEntry } from "~/contracts/run.contract";
import { formatDuration } from "~/lib/format-duration";
import { formatCurrency, formatPercent } from "~/lib/number-format";
import type { Database } from "~/server/db";
import { listAuditLog } from "~/server/operations/audit-log";
import {
  loadRunDetail,
  loadRunLog,
} from "~/server/purchase-import/run-service";
import { listAiUsageForRun } from "~/server/repo/ai-usage";
import { getRunByShortcode } from "~/server/repo/run";
import { getRunLiveProgress } from "~/server/repo/run-progress";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

/**
 * The Run detail's report blocks: progress, approvals, findings, transcript, log, AI usage and
 * changes, composed once for web and native. Every sentence, empty-state line, visibility rule
 * and action below is written here; a client lays the blocks out. A report that does not apply
 * to the run (the other progress variant, targets a run never had) is no blocks, so the client
 * hides its section. The builders are pure over what the loaders return; `runReport` is the
 * only one that reads.
 */

type RunLiveProgress = NonNullable<
  Awaited<ReturnType<typeof getRunLiveProgress>>
>;
type Block<Kind extends ReportBlock["kind"]> = Extract<
  ReportBlock,
  { kind: Kind }
>;
type Row = Block<"records">["rows"][number];
type Tone = NonNullable<NonNullable<Row["statuses"]>[number]["tone"]>;
type Line = NonNullable<Row["lines"]>[number];

/** What a run builder says about one record row; `row` lays it out as the shared row shape. */
interface RowFields {
  title?: string | undefined;
  body?: string | undefined;
  at?: string | undefined;
  badges?: Array<{ label: string; tone?: Tone | undefined }>;
  lines?: Line[];
  ref?: { entity: string; id: string } | undefined;
  detail?: { label: string; text: string } | undefined;
  actions?: ReportCommand[];
}

const LIVE_STATUSES: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUSES);
const IMPORT_PURPOSES: ReadonlySet<string> = new Set(IMPORT_WORKFLOW_PURPOSES);

/** A run that is still moving: clients poll and offer controls only while this holds. */
export const isLiveRunStatus = (status: string): boolean =>
  LIVE_STATUSES.has(status);

/** A queued task that has not started after this long may be resent to the queue. */
const QUEUE_RETRY_AFTER_SECONDS = 180;

const toneForState = (state: string): Tone | undefined => {
  if (state === "completed") return "positive";
  if (state === "failed" || state === "cancelled" || state === "aborted")
    return "destructive";
  if (state.startsWith("paused")) return "warning";
  return undefined;
};

const phaseLabel = (phase: string) =>
  phase.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());

const line = (text: string, tone?: Tone): Line =>
  tone ? { text, tone } : { text };

const badge = (label: string, tone?: Tone) =>
  tone ? { label, tone } : { label };

/** A record row of the shared `records` block; `id` is its stable key. */
const row = (id: string, fields: RowFields = {}): Row => ({
  entity: fields.ref?.entity ?? null,
  id: fields.ref?.id ?? null,
  title: fields.title ?? "",
  subtitle: fields.body ?? null,
  trailing: null,
  key: id,
  at: fields.at,
  statuses: fields.badges ?? [],
  lines: fields.lines ?? [],
  detail: fields.detail,
  commands: fields.actions ?? [],
});

/** `empty` is the copy for no rows; an empty string hides the block. */
const records = (
  rows: Row[],
  fields: { title?: string; empty?: string } = {},
): Block<"records"> => ({
  kind: "records",
  title: fields.title,
  rows,
  empty: fields.empty ?? "",
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

const dateTimeLabel = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: HOUSEHOLD_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

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

const importStats = (run: RunDetail): ReportBlock[] => [
  counts([
    ["Orders seen", run.ordersSeen],
    ["Imported", run.imported],
    ["Updated", run.updated],
    ["Skipped", run.skipped],
  ]),
];

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
          }),
        ),
        { title: "Run progress history" },
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

/** The reviewable text and apply confirmation of a finding's proposed fix. */
function findingFix(finding: RunDetail["findings"][number]) {
  const fix = finding.proposedFix;
  const lines: Line[] = [];
  if (fix === null || fix.kind === "receive_purchase")
    return { lines, applyConfirm: null };
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
          line(`Expires ${dateTimeLabel(finding.expiresAt)}`, "muted"),
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
  run.targets.length === 0 && run.evidence.length === 0
    ? []
    : [
        note("The selected source and target are frozen for this run."),
        records(
          run.targets.map((target) =>
            row(target.id, {
              title:
                target.targetName ??
                target.targetShortcode ??
                target.targetType,
              badges: [badge(target.state, toneForState(target.state))],
              lines: [
                line(
                  `${target.sourceLabel ?? "No source selected"}${target.vendorAccountLabel ? ` · ${target.vendorAccountLabel}` : ""}`,
                  "muted",
                ),
                ...(target.outcome ? [line(`Outcome: ${target.outcome}`)] : []),
                ...(target.warning ? [line(target.warning, "warning")] : []),
              ],
              ref: target.targetShortcode
                ? { entity: target.targetType, id: target.targetShortcode }
                : undefined,
            }),
          ),
          { empty: "No explicit targets were recorded for this account sync." },
        ),
      ];

const importEvidence = (run: RunDetail): ReportBlock[] =>
  run.targets.length === 0 && run.evidence.length === 0
    ? []
    : [
        note(
          "This evidence belongs to the run. Validation does not attach it to a purchase or product.",
        ),
        records(
          run.evidence.map((evidence) =>
            row(evidence.id, {
              title: evidence.filename ?? evidence.sourceKind,
              at: evidence.createdAt,
              lines: [
                line(
                  `${evidence.sourceKind}${evidence.mediaType ? ` · ${evidence.mediaType}` : ""}${evidence.checksum ? ` · ${evidence.checksum}` : ""}`,
                  "muted",
                ),
              ],
            }),
          ),
          { empty: "No run-scoped evidence was retained." },
        ),
      ];

const importTimeline = (run: RunDetail): ReportBlock[] => [
  note(
    "Oldest first. System and Mac events are retained as structured operation evidence; sensitive page content and credentials are excluded.",
  ),
  records(
    run.operations.map((operation) =>
      row(operation.operationId, {
        title: operation.kind,
        at: operation.startedAt,
        badges: [badge(operation.state, toneForState(operation.state))],
        lines: [
          line(operation.operationId, "muted"),
          ...(operation.error ? [line(operation.error, "destructive")] : []),
        ],
      }),
    ),
    { empty: "No durable operations have been recorded for this run." },
  ),
];

type PreparedOrder = RunDetail["preparedOrders"][number];
type PreparedLine = PreparedOrder["lines"][number];

const COMMITTED = "Prepared import approved and committed.";
const APPROVE_BLOCKED =
  "Prepared orders can be approved only while an account sync run is running.";
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
        badges: candidate.exactIdentifierMatch ? ["Exact identifier"] : [],
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
  const blocked = run.status !== "running" || run.purpose !== "account_sync";
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
  "run.import-evidence": importEvidence,
  "run.import-prepared-orders": importPreparedOrders,
  "run.import-timeline": importTimeline,
} as const satisfies Record<string, (run: RunDetail) => ReportBlock[]>;
export type ImportReportSlot = keyof typeof IMPORT_BUILDERS;

/**
 * One import slot's blocks. A run outside the import workflow gets none; a photo batch keeps
 * only the durable transcript beneath its own review.
 */
export function importReportBlocks(
  slot: ImportReportSlot,
  run: RunDetail,
): ReportBlock[] {
  if (run.purpose === "photo_inventory")
    return slot === "run.import-timeline" ? importTimeline(run) : [];
  return IMPORT_PURPOSES.has(run.purpose) ? IMPORT_BUILDERS[slot](run) : [];
}

const ORDER_OUTCOME = {
  pending: ["Waiting", undefined],
  imported: ["Imported", undefined],
  skipped: ["Needs review", "muted"],
  covered: ["Already covered", undefined],
} as const satisfies Record<string, readonly [string, Tone | undefined]>;

const CHARGE_OUTCOME = {
  pending: "Searching",
  resolved: "Settled",
  deferred: "Needs review",
  not_found: "Order not found",
} as const;

type GmailProgress = NonNullable<RunLiveProgress["gmail"]>;

/** The status sentence over the progress rows: what the run is doing, or how it ended. */
function progressHeadline(progress: RunLiveProgress): string {
  const active = progress.status === "running";
  const last = progress.progress.at(-1);
  if (active && progress.gmail?.status === "queued")
    return last?.phase === "rate_limited"
      ? "AI Gateway rate limited; waiting to retry"
      : "Waiting for background worker";
  if (active) return last?.detail ?? "Working…";
  if (progress.status === "completed") return "Run completed";
  if (progress.status === "failed") return "Run failed";
  return phaseLabel(progress.status);
}

/** How long the run has waited or gone quiet, while it is live. */
function progressAge(progress: RunLiveProgress): string | null {
  if (progress.status !== "running") return null;
  const last = progress.progress.at(-1);
  if (progress.gmail?.status === "queued")
    return `Waiting for ${minutesSeconds(last?.ageSeconds ?? 0)}`;
  return last && last.ageSeconds > 10
    ? `Last update ${minutesSeconds(last.ageSeconds)} ago`
    : "Updating live";
}

/** A queued Gmail task that has sat unstarted this long may be resent to the queue. */
function queueRetryBlocks(
  runId: RunDetail["publicId"],
  progress: RunLiveProgress,
): ReportBlock[] {
  const waiting =
    progress.status === "running" && progress.gmail?.status === "queued";
  if (
    !waiting ||
    (progress.progress.at(-1)?.ageSeconds ?? 0) < QUEUE_RETRY_AFTER_SECONDS
  )
    return [];
  return [
    records(
      [
        row("queue", {
          title:
            "The saved task has not started. Resend it to the background queue.",
          actions: [
            {
              id: "retry-gmail-search",
              label: "Retry queue delivery",
              prominent: false,
              confirm: null,
              request: { kind: "retry-gmail-search", runId },
            },
          ],
        }),
      ],
      { title: "Background queue" },
    ),
  ];
}

function gmailCountsBlock(
  gmail: GmailProgress,
  status: RunLiveProgress["status"],
): ReportBlock {
  const sentence = (id: string, text: string) => row(id, { title: text });
  return records([
    sentence(
      "pages",
      `${gmail.pagesScanned} ${gmail.pagesScanned === 1 ? "page" : "pages"} scanned`,
    ),
    sentence(
      "messages",
      `${gmail.searched} messages ${status === "completed" ? "checked" : "found"}`,
    ),
    sentence("skipped", `${gmail.skipped} already saved`),
    sentence(
      "reviewable",
      `${gmail.reviewable} order ${gmail.reviewable === 1 ? "email" : "emails"} to review`,
    ),
  ]);
}

function searchInputsBlock(gmail: GmailProgress): ReportBlock {
  return records(
    [
      row("date-range", {
        title: "Date range",
        body:
          gmail.after === "1970/01/01"
            ? "All available mail"
            : `Since ${gmail.after.replaceAll("/", "-")}`,
      }),
      row("sender-search", {
        title: "Sender search",
        body: gmail.searchTerms.length
          ? gmail.searchTerms.join(", ")
          : "Criteria were not saved for this earlier Run",
      }),
      row("starting-point", {
        title: "Starting point",
        body: gmail.startedFromOlderPage
          ? "Older Gmail page"
          : "Newest matching email",
      }),
    ],
    { title: "Search inputs" },
  );
}

/** The selected orders and charges a targeted mail or charge-search run works through. */
function selectionBlocks(progress: RunLiveProgress): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  if (progress.orders.length)
    blocks.push(
      records(
        progress.orders.map((order) => {
          const [label, tone] = ORDER_OUTCOME[order.state];
          return row(order.orderId, {
            title: order.orderId,
            badges: [badge(label, tone)],
          });
        }),
        { title: "Selected orders" },
      ),
    );
  if (progress.charges.length)
    blocks.push(
      records(
        progress.charges.map((charge) =>
          row(charge.chargeId, {
            title: charge.chargeId,
            ref: { entity: "financialTransaction", id: charge.chargeId },
            badges: [
              badge(
                CHARGE_OUTCOME[charge.outcome],
                charge.outcome === "resolved" ? undefined : "muted",
              ),
            ],
          }),
        ),
        { title: "Selected charges" },
      ),
    );
  return blocks;
}

/** Durable progress for every Run, including work done outside the page that opened it. */
export function liveProgressBlocks(
  runId: RunDetail["publicId"],
  progress: RunLiveProgress,
): ReportBlock[] {
  const active = progress.status === "running";
  const gmail = progress.gmail;
  const age = progressAge(progress);
  return [
    note(progressHeadline(progress), undefined, true),
    ...(age ? [note(age)] : []),
    ...(gmail?.hasMorePages && active
      ? [note("Continuing to older messages")]
      : []),
    ...queueRetryBlocks(runId, progress),
    ...(gmail ? [gmailCountsBlock(gmail, progress.status)] : []),
    ...selectionBlocks(progress),
    ...(gmail ? [searchInputsBlock(gmail)] : []),
    ...(gmail?.error
      ? [note(gmail.error, gmail.status === "failed" ? "destructive" : "muted")]
      : []),
    records(
      progress.progress.map((event) =>
        row(event.id, {
          title: phaseLabel(event.phase),
          body: event.detail ?? undefined,
          at: event.createdAt,
        }),
      ),
      {
        empty: active
          ? "Waiting for the first progress update…"
          : "No progress updates were recorded for this Run.",
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
    note(
      "Structured server and browser-bridge events are retained when the agent conversation cannot explain a transition.",
    ),
    records(
      log.entries.map((entry) =>
        row(entry.id, {
          title: entry.event,
          at: entry.occurredAt,
          badges: [
            badge(
              entry.source,
              entry.level === "error" ? "destructive" : "muted",
            ),
          ],
          lines: entry.error ? [line(entry.error, "destructive")] : [],
        }),
      ),
      { empty: "No structured log entries were recorded." },
    ),
    ...(log.truncated
      ? [note("This view is limited to the first 2,000 events.", "warning")]
      : []),
  ];
}

/** Every AI call the run grouped, for any run purpose. */
export function aiUsageBlocks(usage: AiRunUsage): ReportBlock[] {
  const estimated = usage.unpricedCount > 0;
  return [
    note(
      `${estimated ? "Estimated subtotal" : "Subtotal"} ${formatCurrency(usage.pricedSubtotal, 6)}${estimated ? ` · ${usage.unpricedCount} unpriced` : ""}`,
      undefined,
      true,
    ),
    records(
      usage.records.map((call) =>
        row(call.id, {
          title: `${call.operation} · ${call.feature} · ${call.provider}`,
          at: call.createdAt.toISOString(),
          badges: [
            badge(
              call.status,
              call.status === "succeeded" ? "positive" : "destructive",
            ),
          ],
          lines: [
            line(`${call.model} · attempt ${call.attempt}`, "muted"),
            line(
              `${call.inputTokens ?? "—"} in / ${call.outputTokens ?? "—"} out`,
            ),
            line(
              `${
                call.applicationCacheStatus === "hit"
                  ? "Application hit · no model call"
                  : `Application ${call.applicationCacheStatus ?? "—"}`
              } · Gateway ${call.cacheStatus ?? "—"} · ${call.cacheReadTokens ?? "—"} read / ${call.cacheWriteTokens ?? "—"} write`,
              "muted",
            ),
            line(
              `${call.durationMs == null ? "—" : formatDuration(call.durationMs)} · ${
                call.estimatedCost == null
                  ? "unpriced"
                  : formatCurrency(call.estimatedCost, 6)
              }${call.gatewayLogId ? ` · ${call.gatewayLogId}` : ""}`,
              "muted",
            ),
          ],
        }),
      ),
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

/** Paged reports ask for this many rows at a time. */
const PAGE_SIZE = 25;

/** The run report slots (`run.*` in `reportSlots`). */
export type RunReportSlot =
  | ImportReportSlot
  | "run.live-progress"
  | "run.import-debug-log"
  | "run.ai-usage"
  | "run.changes";

const IMPORT_SLOT_IDS: ReadonlySet<string> = new Set(
  Object.keys(IMPORT_BUILDERS),
);

/**
 * Composes Run slots' reports, with the run's liveness so clients know to poll. The run detail
 * (about twenty queries) loads once however many import slots are asked for, and the live
 * progress read once, so a page polling all of its slots costs one slot's reads.
 */
export async function runReports<Slot extends RunReportSlot>(
  db: Database,
  slots: readonly Slot[],
  runId: RunDetail["publicId"],
  cursor: string | undefined,
): Promise<Array<{ slot: Slot; report: EntityReportOut }>> {
  const detail = slots.some((slot) => IMPORT_SLOT_IDS.has(slot))
    ? await loadRunDetail(db, runId)
    : undefined;
  const header = detail ? undefined : await getRunByShortcode(db, runId);
  if (!detail && !header) throw new Error("Import run was not found");
  const status = runStatus.parse(detail?.status ?? header?.status);
  const respond = (
    blocks: ReportBlock[],
    nextCursor?: string | null,
  ): EntityReportOut => ({
    blocks,
    live: isLiveRunStatus(status),
    status,
    nextCursor: nextCursor ?? undefined,
  });
  const reports: Array<{ slot: Slot; report: EntityReportOut }> = [];
  for (const slot of slots)
    reports.push({ slot, report: await runSlotReport(slot) });
  return reports;

  async function runSlotReport(slot: RunReportSlot): Promise<EntityReportOut> {
    switch (slot) {
      case "run.ai-usage": {
        const usage = await listAiUsageForRun(
          db,
          await resolveOrThrow(db, "run", runId),
          { cursor, limit: PAGE_SIZE },
        );
        return respond(aiUsageBlocks(usage), usage.nextCursor);
      }
      case "run.changes": {
        const list = await listAuditLog(db, {
          runId,
          cursor,
          limit: PAGE_SIZE,
        });
        return respond(changesBlocks(list), list.nextCursor);
      }
      case "run.import-debug-log":
        return respond(runLogBlocks(await loadRunLog(db, runId)));
      case "run.live-progress": {
        const progress = await getRunLiveProgress(db, runId);
        return respond(
          progress
            ? liveProgressBlocks(runId, progress)
            : [note("Run progress is unavailable.")],
        );
      }
      default:
        // SAFETY: an import slot implies the detail was loaded above.
        return respond(importReportBlocks(slot, detail!));
    }
  }
}

/** One Run slot's report (see `runReports`). */
export async function runReport(
  db: Database,
  slot: RunReportSlot,
  runId: RunDetail["publicId"],
  cursor: string | undefined,
): Promise<EntityReportOut> {
  const [only] = await runReports(db, [slot], runId, cursor);
  if (!only) throw new Error("Import run was not found");
  return only.report;
}
