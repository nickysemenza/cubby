import { formatConfidence } from "@cubby/schemas/ai";
import type {
  SuggestionListRow,
  DeclaredSuggestionEvidence,
} from "@cubby/schemas/suggestion-list";
import { suggestionValueLabel } from "@cubby/schemas/suggestion-list-declarations";
import { countLabel } from "@cubby/shared/pluralize";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { match } from "ts-pattern";

import { useEntityMetadata } from "~/entity/metadata";
import {
  SuggestionBody,
  suggestionBasisLabels,
} from "~/entity/suggestions/suggestion-body";
import { formatCurrency } from "~/lib/number-format";
import { EmptyState } from "~/ui/feedback/empty-state";
import { Facts, FactsDensityProvider } from "~/ui/records/facts";
import { RecordList, RecordRow } from "~/ui/records/record-list";
import { DateDisplay } from "~/ui/values/date-display";

import { acceptItem, wrongItem } from "./suggestion-review";
import { useSuggestionReview } from "./suggestion-review-context";
import { FieldValue, RecordLink } from "./suggestion-values";

function EvidenceBox({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="min-w-0 border-t pt-2">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function EvidenceFacts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <FactsDensityProvider density="compact">
      <Facts
        layout="list"
        facts={rows.map(([label, value]) => ({
          label,
          value: value ?? "None",
        }))}
      />
    </FactsDensityProvider>
  );
}

/** The kind a created transaction takes; a change stays a draft until review. */

/** The charge beside each candidate it could be, with what attaching would copy. */

type FieldRow = Extract<SuggestionListRow, { family: "field" }>;

function FieldEvidence({ row }: { row: FieldRow }) {
  const queryClient = useQueryClient();
  useEntityMetadata(row.evidence.entity);
  const suggestion = row.evidence;
  const { review, outcome } = useSuggestionReview();
  const state = outcome(row.id);
  const value = (raw: unknown, suggested = false) => (
    <FieldValue
      entity={suggestion.entity}
      recordId={suggestion.recordId}
      field={suggestion.field}
      value={raw}
      suggested={suggested}
    />
  );
  return (
    <div className="max-w-xl">
      <SuggestionBody
        current={
          suggestion.kind === "correction"
            ? value(suggestion.currentValue)
            : null
        }
        proposed={value(suggestion.suggestedValue, true)}
        probability={suggestion.confidence}
        runnerUp={
          suggestion.runnerUpValue === null
            ? null
            : {
                label: value(suggestion.runnerUpValue),
                probability: suggestion.runnerUpConfidence,
              }
        }
        basis={suggestionBasisLabels(
          queryClient,
          suggestion.entity,
          suggestion.field,
        )}
        provenance={{
          model: suggestion.model,
          runId: suggestion.runId,
          at: suggestion.createdAt,
        }}
        saving={state?.state === "pending"}
        failure={state?.state === "failed" ? state.error : undefined}
        onAccept={() => void review([row], (target) => acceptItem(target))}
        onReject={() => void review([row], wrongItem)}
      />
    </div>
  );
}

/** A field change an Automatic rule applied: what it wrote and what decided it. */
function AppliedFieldEvidence({ row }: { row: FieldRow }) {
  const suggestion = row.evidence;
  return (
    <div className="max-w-xl">
      <EvidenceBox title="Applied automatically">
        <EvidenceFacts
          rows={[
            [
              "Value",
              <FieldValue
                key="value"
                entity={suggestion.entity}
                recordId={suggestion.recordId}
                field={suggestion.field}
                value={suggestion.suggestedValue}
              />,
            ],
            [
              "Confidence",
              <span key="confidence" className="tabular-nums">
                {formatConfidence(suggestion.confidence)}
              </span>,
            ],
            ["Decision model", suggestion.model],
            [
              "Run",
              suggestion.runId ? (
                <RecordLink
                  key="run"
                  record={{ entity: "run", id: suggestion.runId }}
                />
              ) : null,
            ],
          ]}
        />
      </EvidenceBox>
    </div>
  );
}

type ConnectionRow = Extract<SuggestionListRow, { family: "recommendation" }>;

function ConnectionEvidence({ row }: { row: ConnectionRow }) {
  const proposal = row.evidence;
  if ("kind" in proposal) return <DeclaredEvidence evidence={proposal} />;
  const lines = [
    ...proposal.evidence.reasons.map((text) => ({ text, tone: "" })),
    ...proposal.evidence.contradictions.map((text) => ({
      text: `Conflict: ${text}`,
      tone: "text-destructive",
    })),
    ...proposal.evidence.unknowns.map((text) => ({
      text: `Unknown: ${text}`,
      tone: "text-muted-foreground",
    })),
  ];
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <EvidenceBox title={proposal.label}>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
          <RecordLink record={row.record} />
          <span aria-hidden className="text-muted-foreground">
            →
          </span>
          {row.other ? <RecordLink record={row.other} /> : null}
        </div>
      </EvidenceBox>
      <EvidenceBox title="Basis">
        {lines.length ? (
          <ul className="flex flex-col gap-0.5 text-xs">
            {lines.map((line) => (
              <li key={line.text} className={line.tone}>
                {line.text}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState size="inline">No stated basis.</EmptyState>
        )}
      </EvidenceBox>
    </div>
  );
}

function TransferPairEvidence({
  row,
}: {
  row: Extract<SuggestionListRow, { family: "transfer_pair" }>;
}) {
  const pair = row.evidence;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {[
          { title: "Money out", leg: pair.outflow },
          { title: "Money in", leg: pair.inflow },
        ].map(({ title, leg }) => (
          <EvidenceBox key={title} title={title}>
            <EvidenceFacts
              rows={[
                [
                  "Account",
                  <RecordLink
                    key="account"
                    record={{ entity: "financialAccount", id: leg.accountId }}
                  />,
                ],
                [
                  "Owner",
                  leg.owner ? (
                    <RecordLink
                      key="owner"
                      record={{ entity: "ledgerParty", id: leg.owner.id }}
                    />
                  ) : (
                    "Owner missing"
                  ),
                ],
                ["Amount", formatCurrency(leg.amount)],
                ["Date", <DateDisplay key="date" start={leg.date} />],
                ["Description", leg.description],
                [
                  "Transaction",
                  leg.transactionId ? (
                    <RecordLink
                      key="transaction"
                      record={{
                        entity: "financialTransaction",
                        id: leg.transactionId,
                      }}
                    />
                  ) : leg.origin === "cash" ? (
                    "Create cash leg after review"
                  ) : (
                    "Create from statement"
                  ),
                ],
                [
                  "Movement evidence",
                  suggestionValueLabel("movement", leg.movement),
                ],
                [
                  "Decision",
                  leg.movementLabel
                    ? suggestionValueLabel("movement", leg.movementLabel.choice)
                    : "Not labeled",
                ],
                [
                  "Confidence",
                  leg.movementLabel
                    ? suggestionValueLabel(
                        "confidence",
                        leg.movementLabel.confidence,
                      )
                    : null,
                ],
                ["Decision model", leg.movementLabel?.model ?? null],
                [
                  "Statement refs",
                  leg.refs.length ? (
                    <span key="refs" className="break-all">
                      {leg.refs
                        .map((ref) => `${ref.source}: ${ref.externalId}`)
                        .join("; ")}
                    </span>
                  ) : null,
                ],
              ]}
            />
            {leg.overlaps.length ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {countLabel(leg.overlaps.length, "unresolved overlap")};
                reconcile these observations before creating a leg.
              </p>
            ) : null}
          </EvidenceBox>
        ))}
      </div>
      <EvidenceBox title="Pair evidence">
        <EvidenceFacts
          rows={[
            ["Transfer date", <DateDisplay key="date" start={pair.date} />],
            ["Date gap", `${countLabel(pair.dateGapDays, "day")} apart`],
            [
              "Move",
              pair.move === "internal"
                ? "Same owner: internal move"
                : pair.move === "between_owners"
                  ? "Different owners: reviewed money move"
                  : "Set both account owners before applying",
            ],
          ]}
        />
        {pair.reasons.length ? (
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
            {pair.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
        {!pair.apply.available && pair.apply.reason ? (
          <p className="mt-1 text-xs">{pair.apply.reason}</p>
        ) : null}
        {pair.inflow.origin === "cash" ? (
          <p className="mt-1 text-xs">
            The cash leg records the full withdrawal amount; no ATM fee is
            inferred. Record a known fee as its own cash transaction.
          </p>
        ) : null}
      </EvidenceBox>
      {pair.competitors.length ? (
        <EvidenceBox title="Competing candidates">
          <RecordList>
            {pair.competitors.map((candidate) => (
              <RecordRow
                key={`${candidate.against}:${candidate.leg.key}`}
                primary={
                  <RecordLink
                    record={{
                      entity: "financialAccount",
                      id: candidate.leg.accountId,
                    }}
                  />
                }
                secondary={candidate.leg.description}
                facts={[
                  {
                    label: "Competes with",
                    value:
                      candidate.against === "outflow"
                        ? "Money in"
                        : "Money out",
                  },
                  {
                    label: "Amount",
                    value: formatCurrency(candidate.leg.amount),
                  },
                  {
                    label: "Date",
                    value: <DateDisplay start={candidate.leg.date} />,
                  },
                  {
                    label: "Date gap",
                    value: `${countLabel(candidate.dateGapDays, "day")} apart`,
                  },
                ]}
              />
            ))}
          </RecordList>
        </EvidenceBox>
      ) : null}
    </div>
  );
}

/** A row's own evidence, opened beneath it. */

/** Why a listed candidate cannot take this charge; it never blocks a create. */

export function SuggestionEvidence({ row }: { row: SuggestionListRow }) {
  return (
    <div className="px-3 py-2.5 pl-12">
      {match(row)
        .with({ family: "field" }, (field) =>
          field.automaticRule === null ? (
            <FieldEvidence row={field} />
          ) : (
            <AppliedFieldEvidence row={field} />
          ),
        )
        .with({ family: "recommendation" }, (connection) => (
          <ConnectionEvidence row={connection} />
        ))
        .with({ family: "transfer_pair" }, (pair) => (
          <TransferPairEvidence row={pair} />
        ))
        .otherwise(({ evidence }) => (
          <DeclaredEvidence evidence={evidence} />
        ))}
    </div>
  );
}

function DeclaredEvidence({
  evidence,
}: {
  evidence: DeclaredSuggestionEvidence;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm whitespace-pre-wrap">{evidence.description}</p>
      <Facts
        layout="inline"
        facts={evidence.facts.map((fact, index) => ({
          id: `${fact.label}:${index}`,
          label: fact.label,
          value:
            typeof fact.value === "string"
              ? fact.value
              : JSON.stringify(fact.value),
        }))}
      />
    </div>
  );
}
