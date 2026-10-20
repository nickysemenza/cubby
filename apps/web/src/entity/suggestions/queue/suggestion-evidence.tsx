import { formatConfidence } from "@cubby/schemas/ai";
import { financialTransactionKind } from "@cubby/schemas/financial-transaction";
import type {
  SpendingCategoryShortcode,
  PurchaseShortcode,
  VendorShortcode,
} from "@cubby/schemas/identifiers";
import type {
  SuggestionListRow,
  DeclaredSuggestionEvidence,
} from "@cubby/schemas/suggestion-list";
import { humanize } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { useState, type ReactNode } from "react";
import { match } from "ts-pattern";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { EntityReferencePicker } from "~/entity/picker/entity-reference-picker";
import { Picker as RecordPicker } from "~/entity/picker/picker";
import { WithVendorShortcodeSearch } from "~/entity/picker/with-vendor-search";
import {
  SuggestionBody,
  suggestionBasisLabels,
} from "~/entity/suggestions/suggestion-body";
import { renderOptionCell } from "~/entity/table/column-helpers";
import { formatCurrency } from "~/lib/number-format";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { Picker } from "~/ui/combobox/picker";
import { DateDisplay } from "~/ui/common/date-display";
import { FactList } from "~/ui/common/fact-list";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { Section } from "~/ui/layout/section";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Input } from "~/ui/primitives/input";

import {
  CounterpartyLine,
  KindVotes,
  TransferLine,
} from "./statement-kind-votes";
import {
  acceptItem,
  statementApplyItem,
  wrongItem,
  type StatementTransactionField,
} from "./suggestion-review";
import { useSuggestionReview } from "./suggestion-review-context";
import { FieldValue, RecordLink } from "./suggestion-values";

const KIND_OPTIONS = fieldEnumOptions("financialTransaction", "kind");

function SpendingEvidence({ row }: { row: StatementRow }) {
  const { draft, setDraft, outcome } = useSuggestionReview();
  const current = draft(row.id);
  const plan = row.evidence.spending;
  const [category, setCategory] =
    useState<ComboboxItem<SpendingCategoryShortcode> | null>(null);
  const [purchase, setPurchase] =
    useState<ComboboxItem<PurchaseShortcode> | null>(null);
  const [vendor, setVendor] = useState<ComboboxItem<VendorShortcode> | null>(
    null,
  );
  if (!plan) return null;
  const busy = outcome(row.id)?.state === "pending";
  const booking = {
    rejectedPurchaseIds: plan.request.rejectedPurchaseIds,
    ...current.booking,
  };
  return (
    <section
      aria-label="Spending"
      className="flex flex-col gap-2 border-t pt-2 text-xs"
    >
      <p className="font-medium">
        {plan.status === "already_booked"
          ? "Spending already booked"
          : plan.status === "deferred"
            ? "Settlement only"
            : "Book spending"}
      </p>
      {plan.status === "deferred" || plan.status === "review_required" ? (
        <p>{plan.reason}</p>
      ) : null}
      {plan.status === "already_booked"
        ? plan.purchaseIds.map((id) => (
            <RecordLink key={id} record={{ entity: "purchase", id }} />
          ))
        : null}
      {plan.status === "ready" ? (
        <Facts
          rows={[
            [
              "Effect",
              plan.effect === "create_aggregate"
                ? plan.purchaseId
                  ? "One lump Expense on the existing Purchase"
                  : "One Purchase and one lump Expense"
                : "Settle existing spending",
            ],
            [
              "Vendor",
              plan.vendorId ? (
                <RecordLink
                  key="vendor"
                  record={{ entity: "vendor", id: plan.vendorId }}
                />
              ) : (
                plan.vendorName
              ),
            ],
            [
              "Spending category",
              <FieldValue
                key="category"
                entity="expense"
                field="spendingCategoryId"
                value={plan.spendingCategoryId}
              />,
            ],
            [
              "Purchaser",
              <RecordLink
                key="purchaser"
                record={{ entity: "ledgerParty", id: plan.purchaserId }}
              />,
            ],
          ]}
        />
      ) : null}
      {plan.candidates.length ? (
        <ul
          aria-label="Possible existing Purchases"
          className="flex flex-col gap-1"
        >
          {plan.candidates.map((candidate) => (
            <li
              key={candidate.purchaseId}
              className="flex flex-wrap items-center gap-2"
            >
              <RecordLink
                record={{ entity: "purchase", id: candidate.purchaseId }}
              />
              <span className="text-muted-foreground">
                {candidate.strength === "strong"
                  ? "Retained payment evidence"
                  : "Needs matching review"}
              </span>
              {!row.automaticRule &&
              plan.status !== "already_booked" &&
              plan.status !== "deferred" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setPurchase({
                      id: candidate.purchaseId,
                      name: candidate.name,
                    });
                    setDraft(row.id, {
                      booking: { ...booking, purchaseId: candidate.purchaseId },
                    });
                  }}
                >
                  Use this Purchase
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!row.automaticRule &&
      plan.status !== "already_booked" &&
      plan.status !== "deferred" ? (
        <Section
          title="Correct booking"
          headingAs="h4"
          disclosure={{
            defaultOpen: plan.status === "review_required",
            keepMounted: true,
          }}
        >
          <div className="flex flex-col gap-2 pt-2">
            <p>
              Acceptance books spending. Corrections record Wrong feedback for
              the proposed booking.
            </p>
            <p>
              Review account ownership:{" "}
              <RecordLink
                record={{
                  entity: "financialAccount",
                  id: row.evidence.accountId,
                }}
              />
            </p>
            <EntityReferencePicker
              entity="spendingCategory"
              label="Reviewed spending category"
              placeholder="Choose a category"
              value={
                category?.id === current.booking?.spendingCategoryId
                  ? category
                  : null
              }
              disabled={busy}
              setValue={(item) => {
                setCategory(item);
                setDraft(row.id, {
                  booking: { ...booking, spendingCategoryId: item?.id },
                });
              }}
            />
            <WithVendorShortcodeSearch>
              {(search) => (
                <RecordPicker
                  {...search}
                  onCreateNew={undefined}
                  entity="vendor"
                  label="Existing Vendor"
                  placeholder="Choose a reviewed Vendor"
                  value={
                    vendor?.id === current.booking?.vendorId ? vendor : null
                  }
                  disabled={busy}
                  setValue={(item) => {
                    setVendor(item);
                    setDraft(row.id, {
                      booking: {
                        ...booking,
                        vendorId: item?.id,
                        reviewedVendorName: undefined,
                      },
                    });
                  }}
                />
              )}
            </WithVendorShortcodeSearch>
            <label
              htmlFor={`spending-vendor-${row.id}`}
              className="flex flex-col gap-1"
            >
              Reviewed new Vendor business name
              <Input
                id={`spending-vendor-${row.id}`}
                value={current.booking?.reviewedVendorName ?? ""}
                placeholder={
                  row.evidence.merchant ??
                  row.evidence.rawDescription ??
                  "Business name"
                }
                disabled={busy}
                onChange={(event) =>
                  setDraft(row.id, {
                    booking: {
                      ...booking,
                      vendorId: undefined,
                      reviewedVendorName: event.target.value || undefined,
                    },
                  })
                }
              />
            </label>
            <label
              htmlFor={`spending-history-${row.id}`}
              className="inline-flex items-center gap-2"
            >
              <Checkbox
                id={`spending-history-${row.id}`}
                disabled={busy}
                checked={current.booking?.categoryHistoryReviewed === true}
                onCheckedChange={(checked) =>
                  setDraft(row.id, {
                    booking: {
                      ...booking,
                      categoryHistoryReviewed: checked === true,
                    },
                  })
                }
              />
              Use this reviewed category despite conflicting merchant history
            </label>
            <EntityReferencePicker
              entity="purchase"
              label="Existing Purchase"
              placeholder="Choose an existing Purchase"
              value={
                purchase?.id === current.booking?.purchaseId ? purchase : null
              }
              disabled={busy}
              setValue={(item) => {
                setPurchase(item);
                setDraft(row.id, {
                  booking: { ...booking, purchaseId: item?.id },
                });
              }}
            />
            {(row.evidence.create?.kind ?? row.columns.kind) === "refund" ? (
              <label
                htmlFor={`spending-standalone-${row.id}`}
                className="inline-flex items-center gap-2"
              >
                <Checkbox
                  id={`spending-standalone-${row.id}`}
                  disabled={busy}
                  checked={current.booking?.purchaseId === null}
                  onCheckedChange={(checked) =>
                    setDraft(row.id, {
                      booking: {
                        ...booking,
                        purchaseId: checked ? null : undefined,
                      },
                    })
                  }
                />
                Book this reviewed refund as a standalone Purchase
              </label>
            ) : null}
            {plan.candidates.length ? (
              <label
                htmlFor={`spending-distinct-${row.id}`}
                className="inline-flex items-center gap-2"
              >
                <Checkbox
                  id={`spending-distinct-${row.id}`}
                  disabled={busy}
                  checked={Boolean(
                    current.booking?.rejectedPurchaseIds?.length,
                  )}
                  onCheckedChange={(checked) =>
                    setDraft(row.id, {
                      booking: {
                        ...booking,
                        rejectedPurchaseIds: checked
                          ? plan.candidates.map(
                              (candidate) => candidate.purchaseId,
                            )
                          : [],
                      },
                    })
                  }
                />
                These Purchases represent different charges
              </label>
            ) : null}
          </div>
        </Section>
      ) : null}
    </section>
  );
}

const FIELD_LABELS = {
  amount: "amount",
  postedDate: "posted date",
  status: "status",
} satisfies Record<StatementTransactionField, string>;

function EvidenceBox({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-md border bg-card px-2.5 py-2">
      <h4 className="mb-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </section>
  );
}

/** Label/value facts; a null value leaves its row out. */
function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
      {rows
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

type StatementRow = Extract<
  SuggestionListRow,
  { family: "statement_transaction" }
>;

/** The kind a created transaction takes; a change stays a draft until review. */
function KindPicker({ row }: { row: StatementRow }) {
  const { draft, setDraft, outcome } = useSuggestionReview();
  const kind = draft(row.id).kind ?? row.evidence.create?.kind ?? null;
  return (
    <Picker
      mode="choose"
      compact
      label="Transaction kind"
      className="w-44"
      options={KIND_OPTIONS}
      value={kind}
      disabled={outcome(row.id)?.state === "pending"}
      onValueChange={(value) => {
        const next = financialTransactionKind.safeParse(value);
        if (next.success) setDraft(row.id, { kind: next.data });
      }}
    />
  );
}

/** The charge beside each candidate it could be, with what attaching would copy. */
function StatementEvidence({ row }: { row: StatementRow }) {
  const charge = row.evidence;
  // An Automatic rule already applied it: evidence only, nothing to choose.
  const settled = row.automaticRule !== null;
  const { draft, setDraft, review, outcome } = useSuggestionReview();
  const rowDraft = draft(row.id);
  const busy = outcome(row.id)?.state === "pending";
  const toggle = (
    transactionId: string,
    field: StatementTransactionField,
    checked: boolean,
  ) => {
    const current = rowDraft.fields[transactionId] ?? [];
    setDraft(row.id, {
      fields: {
        ...rowDraft.fields,
        [transactionId]: checked
          ? [...current, field]
          : current.filter((value) => value !== field),
      },
    });
  };
  const kind = rowDraft.kind ?? charge.create?.kind;
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
      <EvidenceBox title="Statement charge">
        <Facts
          rows={[
            ["Descriptor", charge.rawDescription],
            ["Merchant", charge.merchant],
            [
              "Amount",
              <span key="amount" className="tabular-nums">
                {formatCurrency(charge.amount)}
              </span>,
            ],
            ["Date", <DateDisplay key="date" start={charge.statementDate} />],
            ["Status", humanize(charge.providerStatus)],
            ["Account", <RecordLink key="account" record={row.record} />],
            [
              "Owner",
              charge.ownerId ? (
                <RecordLink
                  key="owner"
                  record={{ entity: "ledgerParty", id: charge.ownerId }}
                />
              ) : null,
            ],
            // Verbatim provider evidence; it sets no spending category.
            [`${humanize(charge.source)} category`, charge.sourceCategory],
          ]}
        />
      </EvidenceBox>
      <EvidenceBox
        title={
          charge.candidates.length
            ? countLabel(charge.candidates.length, "candidate")
            : charge.recommended === "void"
              ? "Hold"
              : "New transaction"
        }
      >
        {charge.candidates.length ? (
          <ul
            className="flex flex-col gap-2"
            aria-label="Candidate transactions"
          >
            {charge.candidates.map((candidate, index) => {
              const ticked = rowDraft.fields[candidate.transactionId] ?? [];
              const recommended =
                charge.recommended === "attach" && index === 0;
              return (
                <li
                  key={candidate.transactionId}
                  className="flex flex-col gap-1 border-b pb-2 last:border-b-0 last:pb-0"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <RecordLink
                      record={{
                        entity: "financialTransaction",
                        id: candidate.transactionId,
                      }}
                    />
                    <span className="tabular-nums">
                      {formatCurrency(candidate.amount)}
                      {candidate.amount === charge.amount ? " =" : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {humanize(candidate.status)}
                      {(candidate.postedDate ?? candidate.transactionDate)
                        ? ` · ${candidate.postedDate ?? candidate.transactionDate}`
                        : ""}
                    </span>
                    {candidate.label ? (
                      <span className="text-muted-foreground italic">
                        Decision model: {candidate.label.same} ·{" "}
                        {candidate.label.confidence}
                        {candidate.label.model
                          ? ` (${candidate.label.model})`
                          : ""}
                        ; advisory
                      </span>
                    ) : null}
                    {candidate.claimed ? (
                      <span className="text-warning-ink">
                        Already settles another charge from this source
                      </span>
                    ) : null}
                  </div>
                  {candidate.diff.length && !settled ? (
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      {candidate.diff.map((field) => (
                        <label
                          key={field}
                          className="inline-flex items-center gap-1"
                        >
                          <Checkbox
                            checked={ticked.includes(field)}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              toggle(candidate.transactionId, field, checked)
                            }
                          />
                          Apply {FIELD_LABELS[field]}
                        </label>
                      ))}
                    </div>
                  ) : null}
                  {!recommended && !settled ? (
                    <div>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void review([row], () =>
                            statementApplyItem(charge, {
                              action: "attach",
                              booking: rowDraft.booking,
                              transactionId: candidate.transactionId,
                              fields: [...ticked],
                            }),
                          )
                        }
                      >
                        Attach to this candidate
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : charge.create ? (
          <Facts
            rows={[
              [
                "Kind",
                settled ? (
                  renderOptionCell(kind, KIND_OPTIONS)
                ) : (
                  <KindPicker key="kind" row={row} />
                ),
              ],
              [
                "Amount",
                <span key="amount" className="tabular-nums">
                  {formatCurrency(charge.create.amount)}
                </span>,
              ],
              ["Status", humanize(charge.create.status)],
            ]}
          />
        ) : (
          <p className="text-xs text-muted-foreground">No transaction.</p>
        )}
        {charge.supersedeTransactionId ? (
          <p className="mt-1 text-xs">
            Settles hold{" "}
            <RecordLink
              record={{
                entity: "financialTransaction",
                id: charge.supersedeTransactionId,
              }}
            />
          </p>
        ) : null}
        {charge.voidTransactionId ? (
          <p className="mt-1 text-xs">
            Voids hold{" "}
            <RecordLink
              record={{
                entity: "financialTransaction",
                id: charge.voidTransactionId,
              }}
            />
            , which no later statement shows.
          </p>
        ) : null}
      </EvidenceBox>
      <EvidenceBox title="Why">
        <div className="flex flex-col gap-1 text-xs">
          <p>
            {settled
              ? "Applied automatically by its Automatic rule."
              : charge.clean
                ? "Clean: deterministic evidence and no competing candidate."
                : "Needs review before it is accepted."}
          </p>
          {charge.create ? (
            <>
              <KindVotes create={charge.create} />
              {/* With candidates the kind only matters to Create anyway. */}
              {charge.candidates.length && !settled ? (
                <KindPicker row={row} />
              ) : null}
              {rowDraft.kind && rowDraft.kind !== charge.create.kind ? (
                <p className="text-muted-foreground">
                  You changed the kind to {humanize(rowDraft.kind)}.
                </p>
              ) : null}
              <CounterpartyLine counterparty={charge.create.counterparty} />
            </>
          ) : null}
          {charge.transfer ? <TransferLine transfer={charge.transfer} /> : null}
          {charge.siblings > 0 ? (
            <p className="text-warning-ink">
              {countLabel(charge.siblings, "similar unmatched charge")}
            </p>
          ) : null}
          {charge.model ? (
            <p className="text-muted-foreground">Labelled by {charge.model}</p>
          ) : null}
        </div>
        <SpendingEvidence row={row} />
      </EvidenceBox>
    </div>
  );
}

type FieldRow = Extract<SuggestionListRow, { family: "field" }>;

function FieldEvidence({ row }: { row: FieldRow }) {
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
        basis={suggestionBasisLabels(suggestion.entity, suggestion.field)}
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
        <Facts
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
          <p className="text-xs text-muted-foreground">No stated basis.</p>
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
            <Facts
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
                ["Movement evidence", humanize(leg.movement)],
                [
                  "Decision",
                  leg.movementLabel
                    ? humanize(leg.movementLabel.choice)
                    : "Not labeled",
                ],
                [
                  "Confidence",
                  leg.movementLabel
                    ? humanize(leg.movementLabel.confidence)
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
        <Facts
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
export function SuggestionEvidence({ row }: { row: SuggestionListRow }) {
  return (
    <div className="px-3 py-2.5 pl-12">
      {match(row)
        .with({ family: "statement_transaction" }, (statement) => (
          <StatementEvidence row={statement} />
        ))
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
      <FactList
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
