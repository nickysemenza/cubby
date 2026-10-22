import { assessmentReviewFamilies } from "@cubby/schemas/assessment-review-family";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { StatementSuggestionOut } from "@cubby/schemas/statement-suggestion";
import type { StatementTransactionAction } from "@cubby/schemas/statement-suggestion";
import { suggestionListFamily } from "@cubby/schemas/suggestion-list";
import type {
  SuggestionImpact,
  SuggestionListRow,
  SuggestionRecordRef,
  SuggestionStrength,
} from "@cubby/schemas/suggestion-list";
import type { TransferPairJudgment } from "@cubby/schemas/transfer-pair-suggestion";
import { humanize, mapRecord } from "@cubby/shared";
import { match } from "ts-pattern";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { renderSuggestedListFieldValue } from "~/entity/display/entity-display";
import { formatCurrency } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Badge } from "~/ui/primitives/badge";
import { NoneValue } from "~/ui/primitives/none-value";

/** Older saved projections retain their original provider observation. */
export const providerCategories = (
  evidence: Pick<
    StatementSuggestionOut,
    "sourceCategories" | "source" | "sourceCategory"
  >,
) =>
  evidence.sourceCategories.length
    ? evidence.sourceCategories
    : [{ source: evidence.source, sourceCategory: evidence.sourceCategory }];

export const FAMILY_LABEL = mapRecord(
  suggestionListFamily.options,
  (family) => assessmentReviewFamilies[family].label,
);

/** Chip order on the page: the family most often bulk-reviewed first. */
export const FAMILY_CHIPS = suggestionListFamily.options.map((family) => ({
  family,
  label: assessmentReviewFamilies[family].label,
}));

const STRENGTH_BARS = { strong: 3, medium: 2, weak: 1 } as const;

/** Strength as three bars with its word for assistive tech and hover. */
export function StrengthMark({ strength }: { strength: SuggestionStrength }) {
  const filled = STRENGTH_BARS[strength];
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${humanize(strength)} evidence`}
    >
      <span aria-hidden className="inline-flex gap-0.5">
        {[1, 2, 3].map((bar) => (
          <i
            key={bar}
            className={cn(
              "block h-2.5 w-1 rounded-[1px]",
              bar <= filled ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </span>
      <span className="text-xs text-muted-foreground">
        {humanize(strength)}
      </span>
    </span>
  );
}

export function CleanBadge({ clean }: { clean: boolean }) {
  return clean ? (
    <Badge variant="positive">Clean</Badge>
  ) : (
    <span className="text-xs text-muted-foreground">Needs review</span>
  );
}

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
  book: {
    label: "Book spending",
    className: "bg-action-create-surface text-action-create",
  },
} satisfies Record<
  StatementTransactionAction,
  { label: string; className: string }
>;

export function ActionBadge({
  action,
}: {
  action: StatementTransactionAction;
}) {
  const presentation = ACTION_PRESENTATION[action];
  return (
    <Badge variant="secondary" className={presentation.className}>
      {presentation.label}
    </Badge>
  );
}

/** What accepting restores or risks, each as its server-worded label. */
/** Impact chips; cautions lead so the "+N" never hides one. */
export function ImpactLabels({ impact }: { impact: SuggestionImpact[] }) {
  if (!impact.length) return <NoneValue />;
  const ordered = [
    ...impact.filter((item) => item.kind === "caution"),
    ...impact.filter((item) => item.kind !== "caution"),
  ];
  // One line: the first label, then "+N" naming the rest. Wrapped badges were
  // clipped mid-line by the 32px row.
  return (
    <ChipCluster
      lines={1}
      limit={1}
      items={ordered.map((item) => ({
        key: `${item.kind}:${item.label}`,
        label: item.label,
        node: (
          <Badge
            className="max-w-full min-w-0 shrink"
            variant={item.kind === "caution" ? "warning" : "outline"}
          >
            <span className="truncate">{item.label}</span>
          </Badge>
        ),
      }))}
    />
  );
}

/** A record by shortcode, always as its named link with the entity's mark. */
export function RecordLink({
  record,
  wrap,
  name,
}: {
  record: SuggestionRecordRef;
  wrap?: boolean;
  name?: string | null;
}) {
  const mobile = useIsMobile();
  const wraps = wrap ?? mobile;
  return (
    <EntityRefLink
      variant="byId"
      entityKind={record.entity}
      entityId={record.id}
      name={name}
      compact={!wraps}
      wrap={wraps}
    />
  );
}

export const fieldLabel = (entity: ShortcodeEntity, field: string) =>
  entityFieldByKey(entity, field)?.label ?? field;

/**
 * A stored or proposed field value as its list cell renders it: a category
 * as its full-path pill, a reference as its record link, an enum by label.
 * `suggested` gives the value the quiet dashed suggestion boundary.
 */
export function FieldValue({
  entity,
  recordId = "",
  field,
  value,
  suggested = false,
}: {
  entity: ShortcodeEntity;
  recordId?: string;
  field: string;
  value: unknown;
  suggested?: boolean;
}) {
  if (value === null || value === undefined || value === "")
    return <NoneValue />;
  return (
    <span
      className={cn(
        "inline-flex min-w-0",
        suggested &&
          "[&_.border]:border-dashed [&_.border]:border-muted-foreground/40",
      )}
    >
      {renderSuggestedListFieldValue(
        entity,
        { id: recordId },
        field,
        // SAFETY: a stored field value is JSON by the evidence schema.
        value as Parameters<typeof renderSuggestedListFieldValue>[3],
      )}
    </span>
  );
}

/** What accepting a pair writes: the legs it creates, then the pairing. */
function transferPairChange({ outflow, inflow }: TransferPairJudgment) {
  const missing = [outflow, inflow].filter((leg) => !leg.transactionId);
  const cash = missing.some((leg) => leg.origin === "cash");
  if (missing.length === 2)
    return cash
      ? "Create 2 legs (full-amount cash) and pair with"
      : "Create 2 legs and pair with";
  if (missing.length === 1)
    return cash
      ? "Create full-amount cash leg and pair with"
      : "Create missing leg and pair with";
  return "Pair with";
}

/** The change one Suggestion makes, in its family's own words. */
export function WhatChanges({ row }: { row: SuggestionListRow }) {
  return match(row)
    .with({ family: "field" }, ({ evidence }) => (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">
          {entitySummary[evidence.entity].singular} ·{" "}
          {fieldLabel(evidence.entity, evidence.field)}
        </span>
        {evidence.kind === "correction" ? (
          <>
            <FieldValue
              entity={evidence.entity}
              recordId={evidence.recordId}
              field={evidence.field}
              value={evidence.currentValue}
            />
            <span aria-label="becomes" className="text-muted-foreground">
              →
            </span>
          </>
        ) : null}
        <FieldValue
          entity={evidence.entity}
          recordId={evidence.recordId}
          field={evidence.field}
          value={evidence.suggestedValue}
          suggested
        />
      </span>
    ))
    .with({ family: "statement_transaction" }, ({ evidence }) => (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <ActionBadge action={evidence.recommended} />
        <span className="tabular-nums">{formatCurrency(evidence.amount)}</span>
        {row.other ? (
          <>
            <span className="text-muted-foreground">
              {evidence.recommended === "attach" ? "to" : "·"}
            </span>
            <RecordLink record={row.other} />
          </>
        ) : null}
      </span>
    ))
    .with({ family: "recommendation" }, ({ evidence }) => (
      <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 truncate text-muted-foreground"
          title={"kind" in evidence ? evidence.description : evidence.label}
        >
          {"kind" in evidence ? evidence.description : evidence.label}
        </span>
        {row.other ? <RecordLink record={row.other} /> : null}
      </span>
    ))
    .with({ family: "transfer_pair" }, ({ evidence }) => (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="tabular-nums">{formatCurrency(evidence.amount)}</span>
        <span className="text-muted-foreground">
          {transferPairChange(evidence)}
        </span>
        {row.other ? <RecordLink record={row.other} /> : null}
      </span>
    ))
    .otherwise(({ evidence }) => <span>{evidence.description}</span>);
}

/** Statement rows name the charge; other families name their record. */
export function SuggestionRecord({ row }: { row: SuggestionListRow }) {
  if (row.family === "transfer_pair")
    return (
      <RecordLink
        record={row.record}
        name={
          row.evidence.outflow.description ?? row.evidence.outflow.accountName
        }
      />
    );
  if (row.family === "statement_transaction") {
    const charge = row.evidence;
    return (
      <RecordLink
        record={row.record}
        name={charge.merchant ?? charge.rawDescription}
      />
    );
  }
  return <RecordLink record={row.record} />;
}
