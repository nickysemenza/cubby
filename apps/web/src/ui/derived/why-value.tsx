import { auditEntitySchema } from "@cubby/schemas/audit";
import {
  scoredEntities,
  dataQualityGap,
  dataQualityException,
} from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  fieldExplanationSource,
  type FieldExplanationOutput,
} from "@cubby/schemas/field-explanation";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { humanize, parseShortcode } from "@cubby/shared";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { ExceptionControls } from "~/entity/fields/field-explanation-exception";
import { fieldExplanation } from "~/integrations/tanstack-query/generated/catalog/fieldExplanation.gen";
import { dataQualityStatusLabel } from "~/lib/data-quality-options";
import { formatCurrency } from "~/lib/number-format";
import { DateDisplay } from "~/ui/common/date-display";
import { Facts } from "~/ui/common/facts";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { CELL_RAIL_BUTTON_CLASS } from "~/ui/data-table/cell-frame";
import { ExternalLinkText } from "~/ui/external-link";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Stack } from "~/ui/layout";
import {
  Disclosure,
  DisclosureBody,
  DisclosureRoot,
  DisclosureTrigger,
} from "~/ui/layout/disclosure";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { NoneValue } from "~/ui/primitives/none-value";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import JsonRenderer from "~/ui/text/json-renderer";

import { DecisionChain, DerivedFreshness } from "./decision-chain";
import { ImageChain } from "./image-chain";
import {
  ResolutionEvidence,
  sectionLabelClassName,
} from "./resolution-evidence";

type ExplanationSource = z.infer<typeof fieldExplanationSource>;
type ExplanationValue = ExplanationSource["value"];
const explanationScalar = z.union([z.string(), z.number(), z.boolean()]);
const explanationRecord = z.record(z.string(), z.json());

export function ReadableExplanationValue({
  value,
  depth = 0,
  property,
}: {
  value: ExplanationValue;
  depth?: number;
  property?: string;
}) {
  if (value === null) return <NoneValue />;
  const textValue = z.string().safeParse(value);
  if (textValue.success && property === "externalId")
    return <span className="break-words">{textValue.data}</span>;
  const reference = textValue.success ? parseShortcode(textValue.data) : null;
  if (reference)
    return (
      <ExplanationEntityLink entity={reference.type} id={reference.shortcode} />
    );
  if (textValue.success) {
    const formatted = readableExplanationText(textValue.data);
    if (formatted) return formatted;
  }
  const amount = property === "amount" ? z.number().safeParse(value) : null;
  if (amount?.success)
    return (
      <span className="font-mono tabular-nums">
        {formatCurrency(amount.data)}
      </span>
    );
  const scalar = explanationScalar.safeParse(value);
  if (scalar.success) {
    const boolean = z.boolean().safeParse(scalar.data);
    const display = boolean.success
      ? boolean.data
        ? "Yes"
        : "No"
      : textValue.success && /^[a-z]+(?:_[a-z]+)+$/.test(textValue.data)
        ? humanize(textValue.data)
        : scalar.data;
    return <span className="break-words">{display}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <NoneValue />;
    const occurrences = new Map<string, number>();
    return (
      <ul className="grid gap-2 pl-4 text-xs">
        {value.map((item) => {
          const contentKey = JSON.stringify(item);
          const occurrence = occurrences.get(contentKey) ?? 0;
          occurrences.set(contentKey, occurrence + 1);
          return (
            <li key={`${contentKey}:${occurrence}`} className="list-disc">
              <ReadableExplanationValue value={item} depth={depth + 1} />
            </li>
          );
        })}
      </ul>
    );
  }
  return <ReadableExplanationRecord value={value} depth={depth} />;
}

function readableExplanationText(value: string) {
  if (/^https?:\/\//i.test(value) && z.url().safeParse(value).success)
    return (
      <ExternalLinkText
        href={value}
        className="max-w-full [&>span]:min-w-0 [&>span]:[overflow-wrap:anywhere]"
      />
    );
  if (z.iso.datetime({ offset: true }).safeParse(value).success)
    return <DateDisplay timestamp={value} />;
  if (z.iso.date().safeParse(value).success)
    return <DateDisplay start={value} />;
  return null;
}

function ReadableExplanationRecord({
  value,
  depth,
}: {
  value: ExplanationValue;
  depth: number;
}) {
  const record = explanationRecord.safeParse(value);
  if (!record.success) return <span>Unavailable</span>;
  const recordID = z.string().safeParse(record.data.id);
  const recordReference = recordID.success
    ? parseShortcode(recordID.data)
    : null;
  if (recordReference) {
    const recordName = z.string().safeParse(record.data.name);
    const facts = Object.fromEntries(
      Object.entries(record.data).filter(
        ([key]) => key !== "id" && key !== "name",
      ),
    );
    return (
      <div className="grid gap-1.5">
        <ExplanationEntityLink
          entity={recordReference.type}
          id={recordReference.shortcode}
          name={recordName.success ? recordName.data : null}
        />
        {Object.keys(facts).length > 0 ? (
          <ReadableExplanationValue value={facts} depth={depth} />
        ) : null}
      </div>
    );
  }
  return (
    <div className="@container">
      <dl className="grid gap-x-3 gap-y-1 text-xs @min-[18rem]:grid-cols-[minmax(5rem,0.35fr)_minmax(0,1fr)]">
        {Object.entries(record.data).map(([key, item]) => (
          <div key={key} className="contents">
            <dt className="break-words text-muted-foreground">
              {humanize(key)}
            </dt>
            <dd className="min-w-0">
              <ReadableExplanationValue
                value={item}
                depth={depth + 1}
                property={key}
              />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const explanationSourceKey = (source: ExplanationSource): string =>
  [
    source.label,
    source.entity?.entityKind ?? "value",
    source.entity?.entityId ?? JSON.stringify(source.value),
  ].join(":");

/** Check rows already own the owner's gap and exception facts; related
 * records remain evidence rather than owner score deductions. */
function ownCheckFact(value: ExplanationValue, data: FieldExplanationOutput) {
  const fact = dataQualityGap.safeParse(value);
  const exception = fact.success ? null : dataQualityException.safeParse(value);
  const parsed = fact.success
    ? fact.data
    : exception?.success
      ? exception.data
      : null;
  return (
    parsed !== null &&
    parsed.targetId === data.subject.entityId &&
    parsed.targetType === data.subject.entityKind &&
    data.qualityBreakdown?.checks.some((check) => check.check === parsed.check)
  );
}

function visibleSources(data: FieldExplanationOutput) {
  const named = data.resolution?.sourceEntity;
  return data.sources.flatMap((source) => {
    if (
      named &&
      source.value === null &&
      source.entity?.entityKind === named.entityKind &&
      source.entity.entityId === named.entityId
    )
      return [];
    if (!data.qualityBreakdown) return [source];
    if (ownCheckFact(source.value, data)) return [];
    const value = Array.isArray(source.value)
      ? source.value.filter((item) => !ownCheckFact(item, data))
      : source.value;
    return value === null || (Array.isArray(value) && value.length === 0)
      ? []
      : [{ ...source, value }];
  });
}

export function ExplanationEntityLink({
  entity,
  id,
  name,
}: {
  entity: Entity;
  id: string;
  name?: string | null;
}) {
  if (name && isBrowserRoutedEntity(entity)) {
    return <EntityRefLink entity={entity} id={id} name={name} />;
  }
  const auditable = auditEntitySchema.safeParse(entity);
  return auditable.success ? (
    <EntityRefLink entity={auditable.data} id={id} name={name} />
  ) : isBrowserRoutedEntity(entity) ? (
    <EntityRefLink entity={entity} id={id} name={name ?? id} />
  ) : (
    <span className="font-mono text-xs">{id}</span>
  );
}

function ExplanationSourceRow({ source }: { source: ExplanationSource }) {
  const record = explanationRecord.safeParse(source.value);
  const name = record.success ? z.string().safeParse(record.data.name) : null;
  return (
    <LedgerRow as="div">
      <LedgerCell
        as="dt"
        slot="primary"
        className="text-xs font-medium text-muted-foreground"
      >
        {source.label}
      </LedgerCell>
      <LedgerCell as="dd" slot="secondary" className="grid gap-1.5">
        {source.entity ? (
          <ExplanationEntityLink
            entity={source.entity.entityKind}
            id={source.entity.entityId}
            name={name?.success ? name.data : null}
          />
        ) : null}
        {source.value !== null || source.entity === null ? (
          <ReadableExplanationValue
            value={source.entity ? sourceFacts(source) : source.value}
          />
        ) : null}
      </LedgerCell>
    </LedgerRow>
  );
}

function sourceFacts(source: ExplanationSource): ExplanationValue {
  const record = explanationRecord.safeParse(source.value);
  if (!record.success || !source.entity) return source.value;
  return Object.fromEntries(
    Object.entries(record.data).filter(
      ([key, value]) => key !== "name" && !(value === source.entity?.entityId),
    ),
  );
}

function UnassessedQualityExplanation({
  entity,
  id,
}: Pick<WhyValueProps, "entity" | "id">) {
  const rule = entityFieldModels[entity].fields.find(
    (field) => field.key === "dataQuality",
  )?.explanation;

  return (
    <div className="grid min-w-0 gap-3 p-3 text-sm">
      <PopoverTitle className="text-base font-semibold">
        Data quality
      </PopoverTitle>
      <section className="grid gap-2">
        <h3 className={sectionLabelClassName}>What this means</h3>
        <p className="text-lg font-semibold">Not assessed</p>
        <p className="text-sm leading-relaxed">
          No quality checks are defined for this entity. Review its fields and
          supporting records directly.
        </p>
        {parseShortcode(id)?.type === entity ? (
          <ExplanationEntityLink entity={entity} id={id} name="Open record" />
        ) : null}
      </section>
      <section className="grid gap-2 border-t border-border pt-3">
        <h3 className={sectionLabelClassName}>Technical details</h3>
        <p className="text-sm leading-relaxed">
          There is no score, calculation, or check evaluation for this entity.
          Not assessed is not a score of zero or a guarantee of completeness.
        </p>
        {rule ? (
          <p className="font-mono text-xs break-all">
            Rule: {rule.ruleId} · r{rule.version}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Evaluation: not performed; no checks are defined.
        </p>
      </section>
    </div>
  );
}

type ExplainedCheck = NonNullable<
  FieldExplanationOutput["qualityBreakdown"]
>["checks"][number];

function QualityCheckRow({
  check,
  entityId,
}: {
  check: ExplainedCheck;
  entityId: string;
}) {
  return (
    <LedgerRow
      title={`${humanize(check.facet)} · ${check.check}`}
      data-quality-check={check.check}
    >
      <LedgerCell slot="primary" className="font-medium">
        {check.label}
      </LedgerCell>
      <LedgerCell
        slot="trailing"
        className="flex flex-wrap items-center justify-end gap-2"
      >
        <Badge
          variant={
            check.state === "gap"
              ? check.kind === "defect"
                ? "destructive"
                : "warning"
              : check.state === "excepted"
                ? "secondary"
                : "positive"
          }
        >
          {check.stateLabel}
        </Badge>
      </LedgerCell>
      {check.state === "gap" ? (
        <LedgerCell as="div" slot="detail" className="text-xs leading-5">
          {check.description}
        </LedgerCell>
      ) : null}
      <LedgerCell as="div" slot="actions">
        <ExceptionControls entityId={entityId} check={check} />
      </LedgerCell>
    </LedgerRow>
  );
}

function QualityCalculation({
  breakdown,
  entityId,
}: {
  breakdown: NonNullable<FieldExplanationOutput["qualityBreakdown"]>;
  entityId: string;
}) {
  return (
    <section className="grid gap-2 border-t border-border pt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={sectionLabelClassName}>Score calculation</h3>
        <Badge
          variant={
            breakdown.status === "complete"
              ? "positive"
              : breakdown.status === "defect"
                ? "destructive"
                : breakdown.status === "needs_data"
                  ? "warning"
                  : "secondary"
          }
        >
          {dataQualityStatusLabel(breakdown.status)}
        </Badge>
      </div>
      <Disclosure summary="Score arithmetic">
        <p className="pb-2 text-xs leading-5 tabular-nums">
          {breakdown.summary}
        </p>
        {breakdown.checks.map((check) => (
          <p key={check.check} className="text-xs">
            {check.label} · {check.weightLabel}
          </p>
        ))}
      </Disclosure>
      <Ledger>
        {breakdown.checks.map((check) => (
          <QualityCheckRow
            key={check.check}
            check={check}
            entityId={entityId}
          />
        ))}
      </Ledger>
    </section>
  );
}

type WhyValueProps = {
  entity: Entity;
  id: string;
  field: string;
  label: string;
  surface?: "list" | "detail" | "summary";
  resolution?: FieldResolution | null;
  onSet?: () => void;
  pendingSuggestion?: ReactNode;
  qualityChecks?: NonNullable<
    FieldExplanationOutput["qualityBreakdown"]
  >["checks"];
};

export function WhyValue({
  entity,
  id,
  field,
  label,
  surface = "detail",
  onSet,
}: WhyValueProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            mobileSize="touch"
            className={
              surface === "list"
                ? CELL_RAIL_BUTTON_CLASS
                : "relative z-[1] text-muted-foreground"
            }
            aria-label={`How ${label.toLowerCase()} is determined`}
          />
        }
      >
        <InfoIcon className={surface === "list" ? "size-3" : "size-3.5"} />
      </PopoverTrigger>
      <PopoverContent className="max-h-[min(42rem,85dvh,var(--available-height))] w-[min(25rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain p-0">
        {open &&
        field === "dataQuality" &&
        !z.enum(scoredEntities).safeParse(entity).success ? (
          <UnassessedQualityExplanation entity={entity} id={id} />
        ) : open ? (
          <WhyValueContents
            entity={entity}
            id={id}
            field={field}
            label={label}
            surface={surface}
            onSet={onSet}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Query observers and actions mount only while the explanation is open. */
export function WhyValueContents({
  entity,
  id,
  field,
  label,
  surface = "detail",
  onSet,
  qualityChecks,
  pendingSuggestion,
}: WhyValueProps) {
  const result = useQuery({
    ...fieldExplanation.explain.queryOptions({
      entityKind: entity,
      entityId: id,
      field,
      surface,
    }),
    staleTime: 0,
    refetchOnMount: "always",
  });
  // Long rule identifiers must wrap inside the viewport-bounded popover.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3">
      <PopoverTitle className="text-sm font-semibold">
        Why this value · {label}
      </PopoverTitle>
      {result.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : result.isError ? (
        <Stack gap="sm">
          <ErrorDisplay error={result.error} title="this explanation" />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void result.refetch()}
            disabled={result.isFetching}
          >
            Retry explanation
          </Button>
        </Stack>
      ) : (
        <>
          <DecisionChain
            data={result.data}
            onSet={onSet}
            pending={pendingSuggestion}
          />
          {result.data.interpretation ? (
            <p className="text-xs leading-5">
              {result.data.interpretation.summary}
            </p>
          ) : null}
          <ResolutionEvidence evidence={result.data.resolutionEvidence} />
          {result.data.imageChain ? (
            <ImageChain chain={result.data.imageChain} />
          ) : null}
          {result.data.qualityBreakdown ? (
            <QualityCalculation
              breakdown={result.data.qualityBreakdown}
              entityId={id}
            />
          ) : null}
          {!result.data.qualityBreakdown && qualityChecks?.length ? (
            <Ledger>
              {qualityChecks.map((check) => (
                <QualityCheckRow
                  key={check.check}
                  check={check}
                  entityId={id}
                />
              ))}
            </Ledger>
          ) : null}
          {result.data.interpretation &&
          !explanationScalar.safeParse(result.data.value).success &&
          result.data.value !== null &&
          !result.data.resolution &&
          !result.data.resolutionEvidence &&
          !result.data.qualityBreakdown ? (
            <ReadableExplanationValue value={result.data.value} />
          ) : null}
          {visibleSources(result.data).length > 0 ? (
            <section className="grid gap-2 border-t border-border pt-3">
              <h3 className={sectionLabelClassName}>Evidence</h3>
              <Ledger as="dl" variant="facts">
                {visibleSources(result.data)
                  .slice(0, 6)
                  .map((source) => (
                    <ExplanationSourceRow
                      key={explanationSourceKey(source)}
                      source={source}
                    />
                  ))}
              </Ledger>
              {visibleSources(result.data).length > 6 ? (
                <Disclosure
                  summary={`Show ${visibleSources(result.data).length - 6} more evidence entries`}
                >
                  <Ledger as="dl" variant="facts">
                    {visibleSources(result.data)
                      .slice(6)
                      .map((source) => (
                        <ExplanationSourceRow
                          key={explanationSourceKey(source)}
                          source={source}
                        />
                      ))}
                  </Ledger>
                </Disclosure>
              ) : null}
            </section>
          ) : null}
          {result.data.truncated ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Evidence is bounded; the displayed sources are not an exhaustive
              list.
            </p>
          ) : null}
          <ExplanationTechnicalDetails data={result.data} />
          <ExplanationFooter data={result.data} />
        </>
      )}
    </div>
  );
}

function RawExplanationEvidence({ data }: { data: FieldExplanationOutput }) {
  return (
    <Disclosure summary="Raw evidence and check identifiers">
      <div className="max-h-64 max-w-full overflow-auto text-xs">
        <JsonRenderer input={data} />
      </div>
    </Disclosure>
  );
}

function ExplanationTechnicalDetails({
  data,
}: {
  data: FieldExplanationOutput;
}) {
  return (
    // Parts, not `Disclosure`: the trigger keeps this popover's section-label
    // heading, which `Disclosure`'s summary row cannot carry.
    <DisclosureRoot state={{}} className="border-t border-border pt-2">
      <h3 className={sectionLabelClassName}>
        <DisclosureTrigger>Technical details</DisclosureTrigger>
      </h3>
      <DisclosureBody className="grid gap-2 pt-2">
        <p className="text-xs leading-5">{data.rule.description}</p>
        <Facts
          layout="inline"
          className="text-xs"
          facts={[
            {
              label: "Rule",
              value: `${data.rule.id} · r${data.rule.revision}`,
              className: "font-mono break-all",
            },
            {
              label: "Result code",
              value: String(data.value),
              className: "font-mono",
              hide:
                !z.string().safeParse(data.value).success ||
                data.interpretation?.result === data.value,
            },
            {
              label: "Evaluated",
              value: <DateDisplay timestamp={data.evaluatedAt} />,
            },
          ]}
        />
        {data.qualityBreakdown ? (
          <>
            {data.interpretation?.caveats.map((caveat) => (
              <p key={caveat} className="text-xs text-muted-foreground">
                {caveat}
              </p>
            ))}
          </>
        ) : null}
        <RawExplanationEvidence data={data} />
      </DisclosureBody>
    </DisclosureRoot>
  );
}

function ExplanationFooter({ data }: { data: FieldExplanationOutput }) {
  const derived = data.derived ?? {
    meta: { state: "fresh" as const, decidedBy: null, asOf: null },
    stored: data.value,
    live: data.value,
  };
  return (
    <footer className="sticky bottom-0 z-10 -mx-3 -mb-3 border-t border-border bg-popover px-3 py-2">
      <DerivedFreshness derived={derived} context={data} />
    </footer>
  );
}
