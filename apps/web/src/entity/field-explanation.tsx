import { auditEntitySchema } from "@cubby/schemas/audit";
import { scoredEntities } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  fieldExplanationSource,
  type FieldExplanationOutput,
} from "@cubby/schemas/field-explanation";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { inventoryShortcode } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  inventory,
  fieldExplanation,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/utils";
import { CELL_RAIL_BUTTON_CLASS } from "~/ui/data-table/cell-frame";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Stack } from "~/ui/layout";
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
  sectionLabelClassName,
} from "./field-resolution-explanation";

type ExplanationSource = z.infer<typeof fieldExplanationSource>;
export type ExplanationValue = ExplanationSource["value"];
const explanationScalar = z.union([z.string(), z.number(), z.boolean()]);
const explanationRecord = z.record(z.string(), z.json());

const humanizeKey = (key: string) =>
  key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());

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
  const reference = textValue.success ? parseShortcode(textValue.data) : null;
  if (reference)
    return (
      <ExplanationEntityLink entity={reference.type} id={reference.shortcode} />
    );
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
        ? humanizeKey(textValue.data)
        : scalar.data;
    return <span className="break-words">{display}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <NoneValue />;
    const occurrences = new Map<string, number>();
    return (
      <ul className="grid gap-1 pl-4 text-xs">
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
    <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
      {Object.entries(record.data).map(([key, item]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{humanizeKey(key)}</dt>
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
  );
}

const explanationSourceKey = (source: ExplanationSource): string =>
  [
    source.label,
    source.entity?.entityKind ?? "value",
    source.entity?.entityId ?? JSON.stringify(source.value),
  ].join(":");

/** The resolution row already names its source record, so a bare
 * link-only source pointing at the same record adds nothing. */
function visibleSources(data: FieldExplanationOutput) {
  const named = data.resolution?.sourceEntity;
  if (!named) return data.sources;
  return data.sources.filter(
    (source) =>
      source.value !== null ||
      source.entity?.entityKind !== named.entityKind ||
      source.entity.entityId !== named.entityId,
  );
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
  const auditable = auditEntitySchema.safeParse(entity);
  return auditable.success ? (
    <EntityRefLink
      variant="byId"
      entityKind={auditable.data}
      entityId={id}
      name={name}
    />
  ) : (
    <span className="font-mono text-xs">{id}</span>
  );
}

function ExplanationSourceRow({ source }: { source: ExplanationSource }) {
  const record = explanationRecord.safeParse(source.value);
  const name = record.success ? z.string().safeParse(record.data.name) : null;
  return (
    <div className="grid gap-1">
      <dt className="text-sm text-muted-foreground">{source.label}</dt>
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
    <div className="grid gap-4">
      <PopoverTitle className="text-base font-semibold">
        Data quality
      </PopoverTitle>
      <section className="grid gap-2">
        <h3 className="font-medium">What this means</h3>
        <p className="text-lg font-semibold">Not assessed</p>
        <p className="text-sm leading-relaxed">
          No quality checks are defined for this entity. Review its fields and
          supporting records directly.
        </p>
        {parseShortcode(id)?.type === entity ? (
          <ExplanationEntityLink entity={entity} id={id} name="Open record" />
        ) : null}
      </section>
      <section className="grid gap-2 border-t border-border pt-4">
        <h3 className="font-medium">Technical details</h3>
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

function QualityCalculation({
  breakdown,
  entityId,
}: {
  breakdown: NonNullable<FieldExplanationOutput["qualityBreakdown"]>;
  entityId: string;
}) {
  return (
    <div className="grid gap-3">
      <h4 className="font-medium">Score calculation</h4>
      <p className="text-sm tabular-nums">
        {breakdown.expectedWeight === 0
          ? "No applicable weighted checks: the score is 100/100. Unscored diagnostics remain visible below."
          : `${breakdown.satisfiedWeight} satisfied weight ÷ ${breakdown.expectedWeight} applicable weight × 100 = ${breakdown.score}/100`}
      </p>
      <ul className="grid gap-3">
        {breakdown.checks.map((check) => (
          <li key={check.check} className="grid gap-1 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium">{check.label}</span>
              <span className="text-muted-foreground">
                {check.state === "excepted"
                  ? "Accepted exception"
                  : check.state === "gap"
                    ? check.kind === "defect"
                      ? "Defect"
                      : "Missing data"
                    : "Satisfied"}{" "}
                ·{" "}
                {check.weight === 0
                  ? "Unscored diagnostic"
                  : `weight ${check.weight}`}
              </span>
            </div>
            {check.state === "gap" ? <p>{check.description}</p> : null}
            <ExceptionControls entityId={entityId} check={check} />
            <p className="text-xs text-muted-foreground">
              {humanizeKey(check.facet)} ·{" "}
              <span className="font-mono break-all">{check.check}</span>
            </p>
          </li>
        ))}
      </ul>
    </div>
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
      <PopoverContent className="max-h-[min(42rem,85dvh,var(--available-height))] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto">
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
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
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
          <section className="grid gap-3">
            <h3 className="font-medium">What this means</h3>
            {result.data.interpretation ? (
              <>
                <p className="text-lg font-semibold break-words">
                  {result.data.interpretation.result}
                </p>
                <p className="text-sm leading-relaxed">
                  {result.data.interpretation.summary}
                </p>
                {result.data.interpretation.caveats.map((caveat) => (
                  <p key={caveat} className="text-sm text-muted-foreground">
                    {caveat}
                  </p>
                ))}
                {result.data.interpretation.nextSteps.length > 0 ? (
                  <div className="grid gap-1.5">
                    <h4 className="font-medium">Next steps</h4>
                    <ul className="list-disc pl-4 text-sm">
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
          <section className="grid gap-3 border-t border-border pt-4">
            <h3 className="font-medium">Technical details</h3>
            <p className="text-sm leading-relaxed">
              {result.data.rule.description}
            </p>
            <dl className="grid gap-1 text-xs text-muted-foreground">
              <div>
                <dt className="inline">Rule: </dt>
                <dd className="inline font-mono break-all">
                  {result.data.rule.id} · r{result.data.rule.revision}
                </dd>
              </div>
              {z.string().safeParse(result.data.value).success &&
              result.data.interpretation?.result !== result.data.value ? (
                <div>
                  <dt className="inline">Result code: </dt>
                  <dd className="inline font-mono">
                    {String(result.data.value)}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="inline">Evaluated: </dt>
                <dd className="inline">
                  {new Date(result.data.evaluatedAt).toLocaleString()}
                </dd>
              </div>
            </dl>
            {result.data.qualityBreakdown ? (
              <QualityCalculation
                breakdown={result.data.qualityBreakdown}
                entityId={id}
              />
            ) : null}
            {!explanationScalar.safeParse(result.data.value).success &&
            result.data.value !== null &&
            !result.data.resolution ? (
              <ReadableExplanationValue value={result.data.value} />
            ) : null}
            {visibleSources(result.data).length > 0 ? (
              <section className="grid gap-1.5">
                <h3 className={sectionLabelClassName}>Evidence</h3>
                <dl className="grid gap-2">
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
                      Show {visibleSources(result.data).length - 6} more
                      evidence entries
                    </summary>
                    <dl className="grid gap-3 pt-3">
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
                  <p className="text-muted-foreground">
                    Evidence is bounded; the displayed sources are not an
                    exhaustive list.
                  </p>
                ) : null}
              </section>
            ) : null}
          </section>
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
    <footer className="grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-border pt-2">
      {actions.length > 0 || resolution?.canReset ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {resets}
          {actions}
        </div>
      ) : null}
    </footer>
  );
}
