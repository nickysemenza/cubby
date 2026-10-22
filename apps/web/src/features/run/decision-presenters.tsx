import type { AssessmentFamily } from "@cubby/schemas/assessment";
import {
  type TransferPairBlocker,
  type TransferPairJudgment,
  type TransferPairLeg,
  transferPairJudgment,
} from "@cubby/schemas/transfer-pair-suggestion";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import type { ReactNode } from "react";
import { z } from "zod";

import type { RunDecision } from "~/contracts/run-detail.contract";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { formatInstant } from "~/lib/date-format";
import { formatCurrency } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { Disclosure } from "~/ui/layout/disclosure";
import { Panel } from "~/ui/layout/panel";
import { SidePanelSection } from "~/ui/overlays/side-panel";
import { StaticTable } from "~/ui/primitives/static-table";

import type { StatusTone } from "../job/job-status";
import { DECISION_STATUS_LABEL, humanizeKey } from "./run-view-model";

/** One ledger facet: a status, or a family's finer reading of one. */
type DecisionFacetDef = {
  key: string;
  label: string;
  tone: StatusTone;
  description: string;
  visibleWhenEmpty?: boolean;
};

type DecisionColumn = {
  id: string;
  header: string;
  cell: (row: RunDecision) => ReactNode;
  value: (row: RunDecision) => string | number | null;
  align?: "right";
  className?: string;
};

/**
 * How one Assessment family reads in the ledger and evidence drawer. Every
 * family gets the generic presenter; a family with a stored judgment schema
 * adds its own columns and evidence.
 */
export type DecisionPresenter = {
  /** "transfer candidates": the ledger caption's noun. */
  noun: string;
  facets: readonly DecisionFacetDef[];
  facetOf: (row: RunDecision) => DecisionFacetDef;
  explanation: (row: RunDecision) => string;
  columns: readonly DecisionColumn[];
  /** Text the ledger search matches. */
  searchText: (row: RunDecision) => string;
  /** The drawer's title line. */
  title: (row: RunDecision) => ReactNode;
  Evidence: (props: { row: RunDecision }) => ReactNode;
};

/** Success states stay visible at zero so readiness cannot be mistaken for application. */
export function decisionFacetCounts(
  rows: readonly RunDecision[],
  presenter: Pick<DecisionPresenter, "facets" | "facetOf">,
) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = presenter.facetOf(row).key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return presenter.facets
    .filter((def) => def.visibleWhenEmpty || counts.has(def.key))
    .map((def) => ({ ...def, count: counts.get(def.key) ?? 0 }));
}

const STATUS_FACETS = {
  pending: {
    key: "pending",
    label: DECISION_STATUS_LABEL.pending,
    tone: "info",
    description: "Review the evidence before deciding what to record.",
  },
  applied: {
    key: "applied",
    label: DECISION_STATUS_LABEL.applied,
    tone: "positive",
    description: "The recommendation was applied to your records.",
    visibleWhenEmpty: true,
  },
  rejected: {
    key: "rejected",
    label: DECISION_STATUS_LABEL.rejected,
    tone: "neutral",
    description:
      "This recommendation was declined; it is no longer awaiting a decision.",
  },
  superseded: {
    key: "superseded",
    label: DECISION_STATUS_LABEL.superseded,
    tone: "neutral",
    description:
      "A later publication replaced this recommendation. Review the current recommendation instead.",
  },
  resolved: {
    key: "resolved",
    label: DECISION_STATUS_LABEL.resolved,
    tone: "neutral",
    description:
      "Review is complete; no pending action remains on this assessment.",
  },
} as const satisfies Record<RunDecision["status"], DecisionFacetDef>;

const NOT_CURRENT: DecisionFacetDef = {
  key: "not_current",
  label: "No longer current",
  tone: "neutral",
  description:
    "This assessment is no longer current. Review the latest recommendation instead; this one cannot be applied.",
};

const statusFacet = (row: RunDecision) =>
  row.status === "pending" && !row.active
    ? NOT_CURRENT
    : STATUS_FACETS[row.status];

const shortId = (id: string) => `ASM-${id.slice(0, 6).toUpperCase()}`;
const when = (iso: string) => formatInstant(iso, "monthDayTime");

function Attribution({ row }: { row: RunDecision }) {
  return (
    <SidePanelSection title="Attribution">
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Assessment</dt>
        <dd className="font-mono break-all">{row.id}</dd>
        <dt className="text-muted-foreground">Producer</dt>
        <dd>
          {row.producer
            ? [row.producer.kind, row.producer.model, row.producer.revision]
                .filter(Boolean)
                .join(" · ")
            : "—"}
        </dd>
        <dt className="text-muted-foreground">Published</dt>
        <dd>{when(row.createdAt)}</dd>
        <dt className="text-muted-foreground">Updated</dt>
        <dd>
          {when(row.updatedAt)}
          {row.active ? "" : " · no longer current"}
        </dd>
      </dl>
    </SidePanelSection>
  );
}

/** The first named text a stored judgment carries, else its raw JSON. */
const judgmentLabel = z
  .object({
    summary: z.string(),
    label: z.string(),
    key: z.string(),
    reason: z.string(),
  })
  .partial();

const summaryOf = (judgment: unknown): string => {
  if (typeof judgment === "string") return judgment;
  const named = judgmentLabel.safeParse(judgment).data;
  return (
    named?.summary ??
    named?.label ??
    named?.key ??
    named?.reason ??
    JSON.stringify(judgment)
  );
};

const genericPresenter = (family: AssessmentFamily): DecisionPresenter => ({
  noun: `${humanizeKey(family).toLowerCase()} Assessments`,
  facets: [...Object.values(STATUS_FACETS), NOT_CURRENT],
  facetOf: statusFacet,
  explanation: (row) => statusFacet(row).description,
  columns: [
    {
      id: "summary",
      header: "Judgment",
      value: (row) => summaryOf(row.judgment),
      cell: (row) => (
        <span className="block max-w-[28rem] truncate">
          {summaryOf(row.judgment)}
        </span>
      ),
    },
    {
      id: "producer",
      header: "Producer",
      value: (row) => row.producer?.model ?? row.producer?.kind ?? null,
      cell: (row) => row.producer?.model ?? row.producer?.kind ?? "—",
      className: "text-muted-foreground",
    },
    {
      id: "created",
      header: "Published",
      value: (row) => row.createdAt,
      cell: (row) => when(row.createdAt),
    },
    {
      id: "id",
      header: "Assessment",
      value: (row) => row.id,
      cell: (row) => <span className="font-mono">{shortId(row.id)}</span>,
    },
  ],
  searchText: (row) => `${summaryOf(row.judgment)} ${row.id}`,
  title: (row) => summaryOf(row.judgment),
  Evidence: ({ row }) => (
    <>
      <SidePanelSection title="What this means">
        <p className="text-xs">{statusFacet(row).description}</p>
      </SidePanelSection>
      <Disclosure summary="Raw diagnostics">
        <pre className="overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-2xs/4 break-words whitespace-pre-wrap">
          {JSON.stringify(row.judgment, null, 2)}
        </pre>
      </Disclosure>
      <Attribution row={row} />
    </>
  ),
});

/* ——— Transfer pairs ——— */

const parse = (row: RunDecision) =>
  transferPairJudgment.safeParse(row.judgment).data;

/** Every check a clean pair passes; a failed one is its stored blocker. */
const CHECKS = [
  [
    "competing_candidates",
    "One opposite leg",
    "No other candidate competes for either side",
  ],
  ["date_gap", "Dates close", "Legs post within the allowed gap"],
  ["owner_missing", "Owners known", "Both accounts have an owner"],
  [
    "owners_differ",
    "Same owner",
    "Both accounts belong to the same person, or the move is recorded between them",
  ],
  [
    "weak_movement",
    "Explicit movement",
    "Both legs read as a transfer, not only a matching amount",
  ],
  [
    "unresolved_overlap",
    "No overlapping record",
    "No other unresolved record repeats this money",
  ],
  [
    "cash_leg_missing",
    "Both legs recorded",
    "Neither side waits on a created cash leg",
  ],
] as const satisfies readonly (readonly [
  TransferPairBlocker,
  string,
  string,
])[];

const TRANSFER_FACETS = {
  ready: {
    key: "ready_to_apply",
    label: "Ready to apply",
    tone: "positive",
    description:
      "All recorded checks passed and apply is available. Review and apply the recommendation to record the transfer; nothing has changed yet.",
    visibleWhenEmpty: true,
  },
  needs_review: {
    key: "needs_review",
    label: "Needs review",
    tone: "info",
    description:
      "Some evidence needs review before this can be treated as a confirmed transfer.",
  },
  ambiguous: {
    key: "ambiguous",
    label: "Multiple possible matches",
    tone: "warning",
    description:
      "More than one candidate could match a side of this transfer. Review the alternatives before recording it.",
  },
  ...STATUS_FACETS,
} as const satisfies Record<string, DecisionFacetDef>;

const transferFacet = (row: RunDecision): DecisionFacetDef => {
  if (row.status !== "pending" || !row.active) return statusFacet(row);
  const judgment = parse(row);
  if (
    judgment?.clean &&
    judgment.blockers.length === 0 &&
    judgment.apply.available
  )
    return TRANSFER_FACETS.ready;
  if (!judgment) return TRANSFER_FACETS.needs_review;
  return judgment.blockers.includes("competing_candidates")
    ? TRANSFER_FACETS.ambiguous
    : TRANSFER_FACETS.needs_review;
};

const BLOCKER_EXPLANATION = {
  competing_candidates: "More than one candidate could match this movement.",
  date_gap: "The two posting dates are farther apart than the matching limit.",
  owner_missing: "An account owner is missing.",
  owners_differ:
    "The account owners differ and the movement between them needs review.",
  weak_movement:
    "The descriptions do not provide enough evidence that both sides are a transfer.",
  unresolved_overlap: "Another unresolved record may represent the same money.",
  cash_leg_missing: "The cash side has not been recorded.",
} satisfies Record<TransferPairBlocker, string>;

export function decisionExplanation(row: RunDecision): string {
  if (row.status === "applied")
    return "Recorded as a transfer. This recommendation has already been applied; no further apply is needed.";
  const facet = transferFacet(row);
  if (row.status !== "pending" || !row.active) return facet.description;
  const judgment = parse(row);
  if (!judgment)
    return "The stored evidence could not be read. Review the raw diagnostics; apply readiness is unknown.";
  if (facet.key === "ready_to_apply") return facet.description;
  const reasons = judgment.blockers.map(
    (blocker) => BLOCKER_EXPLANATION[blocker],
  );
  return [
    ...reasons,
    judgment.apply.available
      ? "A reviewed apply is available, but this is not a confirmed transfer and nothing has changed yet."
      : "Apply is unavailable. Review the stored reason in Raw diagnostics; nothing has changed yet.",
  ].join(" ");
}

const account = (leg: Pick<TransferPairLeg, "accountName">) => leg.accountName;

function Leg({
  leg,
  direction,
}: {
  leg: TransferPairLeg;
  direction: "out" | "in";
}) {
  const Icon = direction === "out" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon
        aria-label={direction === "out" ? "Outflow" : "Inflow"}
        className="size-3 shrink-0 text-muted-foreground"
      />
      <span className="truncate text-foreground">{account(leg)}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatInstant(`${leg.date}T12:00:00Z`, "dateShort")}
      </span>
    </span>
  );
}

const passed = (judgment: TransferPairJudgment) =>
  CHECKS.filter(([blocker]) => !judgment.blockers.includes(blocker)).length;

function TransferEvidence({ row }: { row: RunDecision }) {
  const judgment = parse(row);
  if (!judgment) return genericPresenter("transfer_pair").Evidence({ row });
  const { outflow, inflow } = judgment;
  const legRows: [
    string,
    (leg: TransferPairLeg) => ReactNode,
    boolean | null,
  ][] = [
    ["Account", (leg) => leg.accountName, null],
    [
      "Owner",
      (leg) => leg.owner?.name ?? "No owner",
      outflow.owner?.id === inflow.owner?.id && outflow.owner !== null,
    ],
    [
      "Date",
      (leg) => formatInstant(`${leg.date}T12:00:00Z`, "dateShort"),
      !judgment.blockers.includes("date_gap"),
    ],
    [
      "Amount",
      (leg) => formatCurrency(Math.abs(leg.amount)),
      Math.abs(outflow.amount) === Math.abs(inflow.amount),
    ],
    ["Description", (leg) => leg.description ?? leg.merchant ?? "—", null],
  ];
  return (
    <>
      <SidePanelSection title="What this means">
        <p className="text-xs">{decisionExplanation(row)}</p>
      </SidePanelSection>
      <SidePanelSection title="Legs">
        <StaticTable
          rows={legRows}
          rowKey={([label]) => label}
          columns={[
            {
              id: "field",
              header: <span className="sr-only">Field</span>,
              headClassName: "w-21",
              cellClassName: "text-muted-foreground",
              cell: ([label]) => label,
            },
            {
              id: "outflow",
              header: "Outflow",
              cellClassName: "whitespace-normal break-words",
              cell: ([, value]) => value(outflow),
            },
            {
              id: "inflow",
              header: "Inflow",
              cellClassName: "whitespace-normal break-words",
              cell: ([, value]) => value(inflow),
            },
            {
              id: "match",
              header: <span className="sr-only">Match</span>,
              headClassName: "w-6",
              cell: ([, , same]) =>
                same === null ? null : same ? (
                  <CheckCircleIcon
                    aria-label="Matches"
                    className="size-3.5 text-positive"
                  />
                ) : (
                  <XCircleIcon
                    aria-label="Differs"
                    className="size-3.5 text-destructive"
                  />
                ),
            },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {judgment.dateGapDays} {judgment.dateGapDays === 1 ? "day" : "days"}{" "}
          apart ·{" "}
          {judgment.move === "between_owners"
            ? "money between owners"
            : judgment.move === "internal"
              ? "internal move"
              : "no owner"}
        </p>
      </SidePanelSection>
      <SidePanelSection
        title={`Checks · ${passed(judgment)} of ${CHECKS.length} passed`}
      >
        <ul className="grid">
          {CHECKS.map(([blocker, name, why]) => {
            const failed = judgment.blockers.includes(blocker);
            return (
              <li
                key={blocker}
                className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 border-t border-border/60 py-1.5 text-xs first:border-t-0"
              >
                {failed ? (
                  <XCircleIcon
                    aria-label="Failed"
                    className="mt-0.5 size-3.5 text-destructive"
                  />
                ) : (
                  <CheckCircleIcon
                    aria-label="Passed"
                    className="mt-0.5 size-3.5 text-positive"
                  />
                )}
                <span>
                  <span className="font-medium text-foreground">{name}</span>{" "}
                  <span className="text-muted-foreground">
                    {failed ? BLOCKER_EXPLANATION[blocker] : why}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        <Disclosure summary="Raw diagnostics">
          <pre className="rounded-md bg-muted px-2 py-1.5 font-mono text-2xs/4 break-words whitespace-pre-wrap">
            {JSON.stringify(
              {
                blockers: judgment.blockers,
                reasons: judgment.reasons,
                apply: judgment.apply,
              },
              null,
              2,
            )}
          </pre>
        </Disclosure>
      </SidePanelSection>
      <SidePanelSection title="Outcome">
        <Panel tone="default" flush className="grid overflow-hidden text-xs">
          <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-2.5 px-2.5 py-2">
            <span className="text-muted-foreground">Recommendation</span>
            <span className="grid gap-0.5">
              <strong className="text-sm font-semibold text-foreground-strong">
                {row.status === "applied"
                  ? "Recorded as a transfer"
                  : row.status !== "pending" || !row.active
                    ? "No action on this recommendation"
                    : transferFacet(row).key === "ready_to_apply"
                      ? "Ready to apply"
                      : "Review before recording"}
              </strong>
              {decisionExplanation(row)}
            </span>
          </div>
          <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-2.5 border-t border-border bg-muted px-2.5 py-2">
            <span className="text-muted-foreground">Your records</span>
            <span className="grid gap-0.5">
              <strong className="text-sm font-semibold text-foreground-strong">
                {row.status === "applied"
                  ? "Recorded as a transfer"
                  : row.status === "pending"
                    ? "Nothing changed yet"
                    : `${DECISION_STATUS_LABEL[row.status]}; nothing recorded`}
              </strong>
              Transfers create no Expenses.
            </span>
          </div>
        </Panel>
      </SidePanelSection>
      <SidePanelSection title="Sources">
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
          {[outflow, inflow].map((leg) =>
            leg.transactionId ? (
              <EntityRefLink
                key={leg.key}
                variant="byId"
                entityKind="financialTransaction"
                entityId={leg.transactionId}
              />
            ) : (
              <span key={leg.key} className="text-muted-foreground">
                {leg.accountName}: created on apply
              </span>
            ),
          )}
          <EntityRefLink
            variant="byId"
            entityKind="financialAccount"
            entityId={outflow.accountId}
          />
          <EntityRefLink
            variant="byId"
            entityKind="financialAccount"
            entityId={inflow.accountId}
          />
        </div>
      </SidePanelSection>
      <Attribution row={row} />
    </>
  );
}

const transferPairPresenter: DecisionPresenter = {
  noun: "transfer candidates",
  facets: [
    TRANSFER_FACETS.ready,
    TRANSFER_FACETS.needs_review,
    TRANSFER_FACETS.ambiguous,
    TRANSFER_FACETS.applied,
    TRANSFER_FACETS.rejected,
    TRANSFER_FACETS.superseded,
    TRANSFER_FACETS.resolved,
    NOT_CURRENT,
  ],
  facetOf: transferFacet,
  explanation: decisionExplanation,
  columns: [
    {
      id: "outflow",
      header: "Outflow",
      value: (row) => parse(row)?.outflow.accountName ?? null,
      cell: (row) => {
        const judgment = parse(row);
        return judgment ? <Leg leg={judgment.outflow} direction="out" /> : "—";
      },
    },
    {
      id: "inflow",
      header: "Inflow",
      value: (row) => parse(row)?.inflow.accountName ?? null,
      cell: (row) => {
        const judgment = parse(row);
        return judgment ? <Leg leg={judgment.inflow} direction="in" /> : "—";
      },
    },
    {
      id: "amount",
      header: "Amount",
      value: (row) => parse(row)?.amount ?? null,
      align: "right",
      className: "font-mono",
      cell: (row) => {
        const judgment = parse(row);
        return judgment ? formatCurrency(judgment.amount) : "—";
      },
    },
    {
      id: "gap",
      header: "Gap",
      value: (row) => parse(row)?.dateGapDays ?? null,
      align: "right",
      className: "font-mono",
      cell: (row) => {
        const judgment = parse(row);
        return judgment ? `${judgment.dateGapDays}d` : "—";
      },
    },
    {
      id: "reason",
      header: "Reason",
      value: (row) => {
        const judgment = parse(row);
        return judgment ? reasonOf(row, judgment) : null;
      },
      className: "text-muted-foreground",
      cell: (row) => {
        return (
          <span className="block max-w-[17.5rem] truncate">
            {decisionExplanation(row)}
          </span>
        );
      },
    },
    {
      id: "checks",
      header: "Checks",
      value: (row) => {
        const judgment = parse(row);
        return judgment ? passed(judgment) : null;
      },
      align: "right",
      className: "font-mono",
      cell: (row) => {
        const judgment = parse(row);
        if (!judgment) return "—";
        const count = passed(judgment);
        return (
          <span className={cn(count < CHECKS.length && "text-destructive")}>
            {count}/{CHECKS.length}
          </span>
        );
      },
    },
    {
      id: "id",
      header: "Assessment",
      value: (row) => row.id,
      className: "font-mono text-muted-foreground",
      cell: (row) => shortId(row.id),
    },
  ],
  searchText: (row) => {
    const judgment = parse(row);
    if (!judgment) return row.id;
    return [
      judgment.outflow.accountName,
      judgment.inflow.accountName,
      judgment.outflow.description,
      judgment.inflow.description,
      judgment.outflow.transactionId,
      judgment.inflow.transactionId,
      formatCurrency(judgment.amount),
      shortId(row.id),
    ]
      .filter(Boolean)
      .join(" ");
  },
  title: (row) => {
    const judgment = parse(row);
    return judgment
      ? `${judgment.outflow.accountName} → ${judgment.inflow.accountName}`
      : shortId(row.id);
  },
  Evidence: TransferEvidence,
};

/** The family's presenter: its own when it declares one, the generic otherwise. */
export const presenterFor = (family: AssessmentFamily): DecisionPresenter =>
  family === "transfer_pair" ? transferPairPresenter : genericPresenter(family);
