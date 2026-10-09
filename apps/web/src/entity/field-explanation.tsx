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
import { inventoryShortcode } from "@cubby/schemas/identifiers";
import { humanize, parseShortcode } from "@cubby/shared";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { isBrowserRoutedEntity } from "~/entity/entities";
import {
  inventory,
  fieldExplanation,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { dataQualityStatusLabel } from "~/lib/data-quality-options";
import { formatInstant } from "~/lib/date-format";
import { formatCurrency } from "~/lib/utils";
import { CalendarDate } from "~/ui/common/calendar-date";
import { CELL_RAIL_BUTTON_CLASS } from "~/ui/data-table/cell-frame";
import { ExternalLinkText } from "~/ui/ExternalLink";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import JsonRenderer from "~/ui/json-renderer";
import { Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { NoneValue } from "~/ui/primitives/none-value";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/ui/primitives/popover";

import { ExceptionControls } from "./field-explanation-exception";
import {
  FieldResolutionEntityActions,
  FieldResolutionStatus,
} from "./field-resolution";
import {
  ResolutionExplanation,
  ResolutionHeadline,
  sectionLabelClassName,
} from "./field-resolution-explanation";

type ExplanationSource = z.infer<typeof fieldExplanationSource>;
export type ExplanationValue = ExplanationSource["value"];
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
    return (
      <time dateTime={value} title={value}>
        {formatInstant(value, "dateTime")}
      </time>
    );
  if (z.iso.date().safeParse(value).success)
    return <CalendarDate start={value} />;
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
    return (
      <EntityRefLink variant="chip" entity={entity} id={id} name={name} wrap />
    );
  }
  const auditable = auditEntitySchema.safeParse(entity);
  return auditable.success ? (
    <EntityRefLink
      variant="byId"
      entityKind={auditable.data}
      entityId={id}
      name={name}
      wrap
    />
  ) : isBrowserRoutedEntity(entity) ? (
    <EntityRefLink
      variant="chip"
      entity={entity}
      id={id}
      name={name ?? id}
      wrap
    />
  ) : (
    <span className="font-mono text-xs">{id}</span>
  );
}

function ExplanationSourceRow({ source }: { source: ExplanationSource }) {
  const record = explanationRecord.safeParse(source.value);
  const name = record.success ? z.string().safeParse(record.data.name) : null;
  return (
    <div className="grid items-baseline gap-x-3 gap-y-1 border-b border-border py-2 last:border-0 sm:grid-cols-[minmax(5rem,0.35fr)_minmax(0,1fr)]">
      <dt className="text-xs font-medium text-muted-foreground">
        {source.label}
      </dt>
      <dd className="grid min-w-0 gap-1.5">
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
      </dd>
    </div>
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
}: Pick<FieldExplanationProps, "entity" | "id">) {
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
    <li
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 py-2 first:pt-1"
      title={`${humanize(check.facet)} · ${check.check}`}
      data-quality-check={check.check}
    >
      <div className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="mr-auto text-sm font-medium">{check.label}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {check.weightLabel}
        </span>
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
      </div>
      {check.state === "gap" ? (
        <p className="min-w-0 flex-1 text-xs leading-5">{check.description}</p>
      ) : null}
      <ExceptionControls entityId={entityId} check={check} />
    </li>
  );
}

function QualityCalculation({
  breakdown,
  entityId,
}: {
  breakdown: NonNullable<FieldExplanationOutput["qualityBreakdown"]>;
  entityId: string;
}) {
  const satisfied = breakdown.checks.filter(
    (check) => check.state === "satisfied" && !check.exception,
  );
  const attention = breakdown.checks.filter(
    (check) => check.state !== "satisfied" || check.exception,
  );
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
      <p className="text-xs leading-5 tabular-nums">{breakdown.summary}</p>
      <ul className="grid divide-y divide-border">
        {attention.map((check) => (
          <QualityCheckRow
            key={check.check}
            check={check}
            entityId={entityId}
          />
        ))}
      </ul>
      {satisfied.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-positive">
            {satisfied.length} satisfied checks
          </summary>
          <ul className="mt-1 grid divide-y divide-border">
            {satisfied.map((check) => (
              <QualityCheckRow
                key={check.check}
                check={check}
                entityId={entityId}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

type FieldExplanationProps = {
  entity: Entity;
  id: string;
  field: string;
  label: string;
  surface?: "list" | "detail" | "summary";
  resolution?: FieldResolution | null;
};

function ExplanationResult({
  entity,
  field,
  resolution,
  value,
}: Pick<FieldExplanationProps, "entity" | "field" | "resolution"> & {
  value: ExplanationValue;
}) {
  return resolution ? (
    <ResolutionHeadline entity={entity} field={field} resolution={resolution} />
  ) : (
    <p className="text-lg leading-snug font-semibold break-words">
      <ReadableExplanationValue value={value} />
    </p>
  );
}

export function FieldExplanation({
  entity,
  id,
  field,
  label,
  surface = "detail",
  resolution,
}: FieldExplanationProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            // Off the list rail, the 44px phone target is an `::after`
            // (24px + 2×10px) so a ledger row keeps its value on one line.
            mobileSize={surface === "list" ? "touch" : "compact"}
            className={
              surface === "list"
                ? CELL_RAIL_BUTTON_CLASS
                : "relative after:absolute after:-inset-2.5 md:after:hidden"
            }
            aria-label={`How ${label.toLowerCase()} is determined`}
          />
        }
      >
        {resolution ? (
          <FieldResolutionStatus resolution={resolution} compact />
        ) : (
          <InfoIcon className={surface === "list" ? "size-3" : "size-3.5"} />
        )}
      </PopoverTrigger>
      <PopoverContent className="max-h-[min(42rem,85dvh,var(--available-height))] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain p-0">
        {open &&
        field === "dataQuality" &&
        !z.enum(scoredEntities).safeParse(entity).success ? (
          <UnassessedQualityExplanation entity={entity} id={id} />
        ) : open ? (
          <FieldExplanationContents
            entity={entity}
            id={id}
            field={field}
            label={label}
            surface={surface}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Query observers and actions mount only while the explanation is open. */
function FieldExplanationContents({
  entity,
  id,
  field,
  label,
  surface = "detail",
}: FieldExplanationProps) {
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
  const subjectAction = (target: { entityKind: Entity; entityId: string }) =>
    target.entityKind === entity && target.entityId === id;
  // Long rule identifiers must wrap inside the viewport-bounded popover.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3">
      <PopoverTitle className="text-base font-semibold">
        <span className="sr-only">How </span>
        {label}
        <span className="sr-only"> is determined</span>
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
          <section className="grid gap-2">
            {result.data.interpretation ? (
              <>
                <ExplanationResult
                  entity={entity}
                  field={field}
                  resolution={result.data.resolution}
                  value={result.data.interpretation.result}
                />
                <p className="text-sm leading-5">
                  {result.data.interpretation.summary}
                </p>
                {(!result.data.qualityBreakdown
                  ? result.data.interpretation.caveats
                  : []
                ).map((caveat) => (
                  <p
                    key={caveat}
                    className="text-xs leading-5 text-muted-foreground"
                  >
                    {caveat}
                  </p>
                ))}
                {!result.data.qualityBreakdown &&
                result.data.interpretation.nextSteps.length > 0 ? (
                  <div className="grid gap-1.5">
                    <h4 className={sectionLabelClassName}>Next steps</h4>
                    <ul className="list-disc pl-4 text-xs leading-5">
                      {result.data.interpretation.nextSteps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : null}
            {result.data.resolution ? (
              <ResolutionExplanation
                entity={entity}
                id={id}
                field={field}
                resolution={result.data.resolution}
                evidence={result.data.resolutionEvidence}
                showHeadline={!result.data.interpretation}
              />
            ) : !result.data.interpretation &&
              (result.data.value !== null ||
                !result.data.sources.some(
                  (source) =>
                    source.label === "Project share" ||
                    source.label === "Unassigned share",
                )) ? (
              <div className="text-base font-semibold break-words">
                <ReadableExplanationValue value={result.data.value} />
              </div>
            ) : null}
          </section>
          {result.data.qualityBreakdown ? (
            <QualityCalculation
              breakdown={result.data.qualityBreakdown}
              entityId={id}
            />
          ) : null}
          {!explanationScalar.safeParse(result.data.value).success &&
          result.data.value !== null &&
          !result.data.resolution &&
          !result.data.qualityBreakdown ? (
            <ReadableExplanationValue value={result.data.value} />
          ) : null}
          {visibleSources(result.data).length > 0 ? (
            <section className="grid gap-2 border-t border-border pt-3">
              <h3 className={sectionLabelClassName}>Evidence</h3>
              <dl className="grid">
                {visibleSources(result.data)
                  .slice(0, 6)
                  .map((source) => (
                    <ExplanationSourceRow
                      key={explanationSourceKey(source)}
                      source={source}
                    />
                  ))}
              </dl>
              {visibleSources(result.data).length > 6 ? (
                <details className="grid gap-2">
                  <summary className="cursor-pointer text-sm font-medium">
                    Show {visibleSources(result.data).length - 6} more evidence
                    entries
                  </summary>
                  <dl className="grid pt-2">
                    {visibleSources(result.data)
                      .slice(6)
                      .map((source) => (
                        <ExplanationSourceRow
                          key={explanationSourceKey(source)}
                          source={source}
                        />
                      ))}
                  </dl>
                </details>
              ) : null}
              {result.data.truncated ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  Evidence is bounded; the displayed sources are not an
                  exhaustive list.
                </p>
              ) : null}
            </section>
          ) : null}
          <FieldVerificationEvidence
            verifications={result.data.verifications}
          />
          <ExplanationTechnicalDetails data={result.data} />
          <ExplanationFooter
            entity={entity}
            id={id}
            field={field}
            surface={surface}
            data={result.data}
            isSubject={subjectAction}
          />
        </>
      )}
    </div>
  );
}

// Byte identity stays available in raw evidence; the explanation shows the public member and source.
function visibleVerificationValue(value: ExplanationValue): ExplanationValue {
  const record = explanationRecord.safeParse(value);
  return record.success
    ? Object.fromEntries(
        Object.entries(record.data).filter(([key]) => key !== "contentHash"),
      )
    : value;
}

export function FieldVerificationEvidence({
  verifications,
}: Pick<FieldExplanationOutput, "verifications">) {
  if (verifications.length === 0) return null;
  return (
    <section className="grid gap-3 border-t border-border pt-3">
      <h3 className={sectionLabelClassName}>Source evidence</h3>
      {verifications.map((verification) => (
        <div key={verification.key} className="grid gap-2 text-sm leading-5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
            <ExplanationEntityLink
              entity={verification.run.entityKind}
              id={verification.run.entityId}
              name={verification.run.entityId}
            />
            <time
              dateTime={verification.verifiedAt}
              className="text-muted-foreground"
            >
              {formatInstant(verification.verifiedAt, "dateTime")}
            </time>
          </div>
          <div className="grid gap-1">
            <h4 className="text-xs font-medium text-muted-foreground">
              {entityFieldModels[verification.subject.entityKind].fields.find(
                (field) => field.key === verification.fieldPath.split(".")[0],
              )?.label ?? "Verified value"}
            </h4>
            <ReadableExplanationValue
              value={visibleVerificationValue(verification.value)}
            />
          </div>
          {verification.support && verification.supportRetiredAt === null ? (
            <>
              <p className="break-words">{verification.support.reasoning}</p>
              <blockquote className="break-words text-muted-foreground">
                “{verification.support.observation}”
              </blockquote>
              {verification.support.selectedVariant ? (
                <div className="grid gap-1 text-xs">
                  <p className="font-medium">
                    Selected variant:{" "}
                    {verification.support.selectedVariant.identity}
                  </p>
                  <ReadableExplanationValue
                    value={verification.support.selectedVariant.attributes}
                  />
                  <p>{verification.support.selectedVariant.reasoning}</p>
                </div>
              ) : null}
            </>
          ) : (
            <div className="grid gap-1 text-xs">
              <p className="font-medium text-warning-ink">
                Verification rationale retired
              </p>
              <p>
                Proof gap: this value needs fresh verification. The accepted
                value and source remain available.
              </p>
              {verification.supportRetiredAt ? (
                <time
                  dateTime={verification.supportRetiredAt}
                  className="text-muted-foreground"
                >
                  Retired{" "}
                  {formatInstant(verification.supportRetiredAt, "dateTime")}
                </time>
              ) : null}
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {verification.source.url ? (
              <ExternalLinkText href={verification.source.url}>
                {verification.source.label}
              </ExternalLinkText>
            ) : (
              <span>{verification.source.label}</span>
            )}
            <ExplanationEntityLink
              entity={verification.subject.entityKind}
              id={verification.subject.entityId}
              name={verification.subject.entityId}
            />
          </div>
        </div>
      ))}
    </section>
  );
}

function RawExplanationEvidence({ data }: { data: FieldExplanationOutput }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs font-medium">
        Raw evidence and check identifiers
      </summary>
      {open ? (
        <div className="max-h-64 max-w-full overflow-auto text-xs">
          <JsonRenderer input={data} />
        </div>
      ) : null}
    </details>
  );
}

function ExplanationTechnicalDetails({
  data,
}: {
  data: FieldExplanationOutput;
}) {
  return (
    <details className="grid gap-2 border-t border-border pt-2">
      <summary className="cursor-pointer">
        <h3 className={`${sectionLabelClassName} inline`}>Technical details</h3>
      </summary>
      <p className="text-xs leading-5">{data.rule.description}</p>
      <dl className="grid gap-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline">Rule: </dt>
          <dd className="inline font-mono break-all">
            {data.rule.id} · r{data.rule.revision}
          </dd>
        </div>
        {z.string().safeParse(data.value).success &&
        data.interpretation?.result !== data.value ? (
          <div>
            <dt className="inline">Result code: </dt>
            <dd className="inline font-mono">{String(data.value)}</dd>
          </div>
        ) : null}
        <div>
          <dt className="inline">Evaluated: </dt>
          <dd className="inline">
            {formatInstant(data.evaluatedAt, "dateTime")}
          </dd>
        </div>
      </dl>
      {data.qualityBreakdown ? (
        <>
          {data.interpretation?.caveats.map((caveat) => (
            <p key={caveat} className="text-xs text-muted-foreground">
              {caveat}
            </p>
          ))}
          <RawExplanationEvidence data={data} />
        </>
      ) : null}
    </details>
  );
}

/** Existing mutation and navigation actions retain their original contracts. */
function ExplanationFooter({
  entity,
  id,
  field,
  surface,
  data,
  isSubject,
}: {
  entity: Entity;
  id: string;
  field: string;
  surface: FieldExplanationProps["surface"];
  data: FieldExplanationOutput;
  isSubject: (target: { entityKind: Entity; entityId: string }) => boolean;
}) {
  const inheritOwner = useActionMutation({
    mutationFn: inventory.setOwnership.mutationOptions,
    success: "Using inherited owner",
  });
  const confirmOwner = useActionMutation({
    mutationFn: inventory.confirmOwnership.mutationOptions,
    success: "Owner confirmed",
  });
  const resolution = data.resolution;
  const actions = data.actions.flatMap((action) => {
    const inventoryAction = action.target.entityKind === "inventory";
    if (action.kind === "inheritOwner" && inventoryAction) {
      return [
        <Button
          key={action.kind}
          size="xs"
          variant="outline"
          disabled={inheritOwner.isPending}
          onClick={() =>
            inheritOwner.mutate({
              inventoryEntryId: inventoryShortcode.parse(
                action.target.entityId,
              ),
              ownership: { mode: "inherit" },
            })
          }
        >
          {action.label}
        </Button>,
      ];
    }
    if (
      action.kind === "confirmOwner" &&
      inventoryAction &&
      data.evidenceFingerprint
    ) {
      const evidenceFingerprint = data.evidenceFingerprint;
      return [
        <Button
          key={action.kind}
          size="xs"
          variant="outline"
          disabled={confirmOwner.isPending}
          onClick={() =>
            confirmOwner.mutate({
              inventoryEntryId: inventoryShortcode.parse(
                action.target.entityId,
              ),
              evidenceFingerprint,
            })
          }
        >
          {action.label}
        </Button>,
      ];
    }
    // On its own detail page a link back to the subject goes nowhere.
    const self = isSubject(action.target);
    if (self && surface === "detail") return [];
    return [
      <span key={action.kind} className="flex min-w-0 items-center gap-1.5">
        <span className="text-muted-foreground">
          {self ? "Open" : action.label}
        </span>
        <ExplanationEntityLink
          entity={action.target.entityKind}
          id={action.target.entityId}
        />
      </span>,
    ];
  });
  const resets = resolution ? (
    <FieldResolutionEntityActions
      entity={entity}
      id={id}
      field={field}
      resolution={resolution}
    />
  ) : null;
  if (actions.length === 0 && !resolution?.canReset) return null;
  return (
    <footer className="sticky bottom-0 z-10 -mx-3 -mb-3 grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-border bg-popover px-3 py-2 text-xs">
      {actions.length > 0 || resolution?.canReset ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {resets}
          {actions}
        </div>
      ) : null}
    </footer>
  );
}
