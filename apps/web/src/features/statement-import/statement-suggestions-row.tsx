import type { FinancialTransactionKind } from "@cubby/schemas/financial-transaction";
import {
  financialTransactionKind,
  financialTransactionSettlementViolation,
} from "@cubby/schemas/financial-transaction";
import type {
  StatementSuggestionOut,
  StatementTransactionAction,
} from "@cubby/schemas/statement-suggestion";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { renderOptionCell } from "~/entity/table/column-helpers";
import { formatCurrency } from "~/lib/number-format";
import { Picker } from "~/ui/combobox/picker";
import { DateDisplay } from "~/ui/common/date-display";
import { LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { Row } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";

import type {
  StatementChoice,
  StatementTransactionField,
} from "./statement-suggestions-review";

/** DESIGN.md action channel: create blue, attach graphite inset, change ochre, remove destructive. */
const ACTION_PRESENTATION = {
  create: {
    label: "Create",
    className: "bg-action-create-surface text-action-create",
  },
  attach: {
    label: "Attach",
    className: "bg-action-link-surface text-action-link",
  },
  supersede: {
    label: "Settle hold",
    className: "bg-action-change-surface text-action-change",
  },
  void: {
    label: "Void hold",
    className: "bg-destructive/10 text-action-remove",
  },
} satisfies Record<
  StatementTransactionAction,
  { label: string; className: string }
>;

const FIELD_LABELS = {
  amount: "amount",
  postedDate: "posted date",
  status: "status",
} satisfies Record<StatementTransactionField, string>;

const KIND_OPTIONS = fieldEnumOptions("financialTransaction", "kind");

function ActionBadge({ action }: { action: StatementTransactionAction }) {
  const presentation = ACTION_PRESENTATION[action];
  return (
    <Badge variant="secondary" className={presentation.className}>
      {presentation.label}
    </Badge>
  );
}

function TransactionLink({ id }: { id: string }) {
  return (
    // Suggestions carry only the shortcode, not the displayName a ref chip needs.
    <Link
      to="/financial-transactions/$shortcode"
      params={{ shortcode: id }}
      className="font-mono text-primary hover:underline"
    >
      {id}
    </Link>
  );
}

export type RowOutcome =
  | { state: "pending" }
  | { state: "failed"; error: string };

/**
 * One pending Transaction suggestion: the statement charge, the recommended
 * action, and every alternative the member may choose instead.
 */
export function StatementSuggestionRow({
  suggestion,
  outcome,
  onApply,
  onDismiss,
}: {
  suggestion: StatementSuggestionOut;
  outcome: RowOutcome | undefined;
  onApply: (choice: StatementChoice) => void;
  onDismiss: () => void;
}) {
  const create = suggestion.create;
  const [kind, setKind] = useState<FinancialTransactionKind | undefined>(
    create?.kind,
  );
  const [editingKind, setEditingKind] = useState(
    create !== null && create.kindSource !== "rule",
  );
  const [fields, setFields] = useState<
    Record<string, StatementTransactionField[]>
  >({});
  const busy = outcome?.state === "pending";
  const descriptor = suggestion.merchant ?? suggestion.rawDescription;
  const first = suggestion.candidates[0];
  const toggleField = (
    transactionId: string,
    field: StatementTransactionField,
    checked: boolean,
  ) =>
    setFields((previous) => {
      const current = previous[transactionId] ?? [];
      return {
        ...previous,
        [transactionId]: checked
          ? [...current, field]
          : current.filter((value) => value !== field),
      };
    });
  const recommendedChoice: StatementChoice =
    suggestion.recommended === "attach"
      ? {
          action: "attach",
          transactionId: first?.transactionId,
          fields: first ? fields[first.transactionId] : [],
        }
      : { action: suggestion.recommended, kindOverride: kind };

  return (
    <LedgerRow aria-label={`Suggestion for ${descriptor}`}>
      <LedgerCell slot="leading" className="w-20">
        <ActionBadge action={suggestion.recommended} />
      </LedgerCell>
      <LedgerCell as="div" slot="primary" className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{descriptor}</span>
        {suggestion.merchant ? (
          <span className="truncate text-2xs text-muted-foreground">
            {suggestion.rawDescription}
          </span>
        ) : null}
      </LedgerCell>
      <LedgerCell as="div" slot="trailing" className="flex flex-col items-end">
        <span>{formatCurrency(suggestion.amount)}</span>
        <span className="text-2xs text-muted-foreground">
          <DateDisplay start={suggestion.statementDate} />
        </span>
      </LedgerCell>
      <LedgerCell
        as="div"
        slot="secondary"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      >
        {suggestion.clean ? (
          <Badge variant="positive">Clean</Badge>
        ) : (
          <Badge variant="outline">Needs review</Badge>
        )}
        <span>{suggestion.accountName}</span>
        <span>{suggestion.providerStatus}</span>
        {suggestion.sourceCategory ? (
          <span>{suggestion.sourceCategory}</span>
        ) : null}
        {create ? (
          editingKind ? (
            <Picker
              mode="choose"
              compact
              label={`Transaction kind for ${descriptor}`}
              className="w-44 flex-none"
              // Offer only kinds the transaction can actually be created as.
              options={KIND_OPTIONS.filter(
                (option) =>
                  !financialTransactionSettlementViolation({
                    linked: false,
                    kind: financialTransactionKind.parse(option.value),
                    amount: create.amount,
                  }),
              )}
              value={kind ?? null}
              disabled={busy}
              onValueChange={(next) => {
                if (next) setKind(financialTransactionKind.parse(next));
              }}
            />
          ) : (
            <Row gap="xs" align="center">
              {renderOptionCell(kind ?? create.kind, KIND_OPTIONS)}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="max-md:min-h-11"
                onClick={() => setEditingKind(true)}
              >
                Change kind
              </Button>
            </Row>
          )
        ) : null}
        {create && create.kindSource !== "rule" ? (
          <span>
            Kind from {create.kindSource === "model" ? "model" : "amount sign"}
          </span>
        ) : null}
        {suggestion.siblings > 0 ? (
          <span className="text-warning-ink">
            {suggestion.siblings} similar unmatched{" "}
            {suggestion.siblings === 1 ? "charge" : "charges"}
          </span>
        ) : null}
      </LedgerCell>
      <LedgerCell as="div" slot="detail" className="flex flex-col gap-2 pb-1">
        {suggestion.recommended === "supersede" &&
        suggestion.supersedeTransactionId ? (
          <p className="text-xs">
            Settles hold{" "}
            <TransactionLink id={suggestion.supersedeTransactionId} /> at{" "}
            <span className="tabular-nums">
              {formatCurrency(create?.amount ?? suggestion.amount)}
            </span>
          </p>
        ) : null}
        {suggestion.recommended === "void" && suggestion.voidTransactionId ? (
          <p className="text-xs">
            Voids hold <TransactionLink id={suggestion.voidTransactionId} />,
            which no later statement shows.
          </p>
        ) : null}
        {suggestion.candidates.length ? (
          <ul
            className="flex flex-col gap-1"
            aria-label="Possible existing transactions"
          >
            {suggestion.candidates.map((candidate) => {
              const ticked = fields[candidate.transactionId] ?? [];
              return (
                <li
                  key={candidate.transactionId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-muted/50 px-2 py-1 text-xs"
                >
                  <TransactionLink id={candidate.transactionId} />
                  <span className="tabular-nums">
                    {formatCurrency(candidate.amount)}
                  </span>
                  <span className="text-muted-foreground">
                    {candidate.status}
                    {candidate.postedDate || candidate.transactionDate
                      ? ` · ${candidate.postedDate ?? candidate.transactionDate}`
                      : ""}
                  </span>
                  {candidate.merchant || candidate.rawDescription ? (
                    <span className="min-w-0 truncate text-muted-foreground">
                      {candidate.merchant ?? candidate.rawDescription}
                    </span>
                  ) : null}
                  {candidate.diff.map((field) => (
                    <label
                      key={field}
                      className="inline-flex items-center gap-1"
                    >
                      <Checkbox
                        checked={ticked.includes(field)}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          toggleField(candidate.transactionId, field, checked)
                        }
                      />
                      Copy {FIELD_LABELS[field]}
                    </label>
                  ))}
                  {candidate.label ? (
                    <span className="text-muted-foreground italic">
                      Model reads{" "}
                      {candidate.label.same === "same"
                        ? "the same charge"
                        : candidate.label.same === "different"
                          ? "a different charge"
                          : "too little to tell"}{" "}
                      ({candidate.label.confidence} confidence
                      {candidate.label.model
                        ? `, ${candidate.label.model}`
                        : ""}
                      ); advisory only
                    </span>
                  ) : null}
                  {suggestion.recommended !== "attach" ||
                  candidate.transactionId !== first?.transactionId ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="ml-auto max-md:min-h-11"
                      disabled={busy}
                      onClick={() =>
                        onApply({
                          action: "attach",
                          transactionId: candidate.transactionId,
                          fields: ticked,
                        })
                      }
                    >
                      Attach to this candidate
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {outcome?.state === "failed" ? (
          <p
            role="alert"
            className="text-xs whitespace-pre-wrap text-destructive"
          >
            {outcome.error}
          </p>
        ) : null}
      </LedgerCell>
      <LedgerCell as="div" slot="actions" className="flex flex-wrap gap-1 pb-1">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => onApply(recommendedChoice)}
        >
          Accept
        </Button>
        {create &&
        suggestion.recommended !== "create" &&
        suggestion.candidates.length ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onApply({ action: "create", kindOverride: kind })}
          >
            Create anyway
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onDismiss}
        >
          Dismiss
        </Button>
        {busy ? (
          <span className="self-center text-xs text-muted-foreground">
            Saving…
          </span>
        ) : null}
      </LedgerCell>
    </LedgerRow>
  );
}
