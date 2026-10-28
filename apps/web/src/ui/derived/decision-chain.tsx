import type { Entity } from "@cubby/schemas/entity";
import { fieldDecisionOf, fieldValueOf } from "@cubby/schemas/field-envelope";
import {
  fieldEmptyLabel,
  fieldNoneLabel,
} from "@cubby/schemas/field-envelope-presentation";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  FieldResolutionEntityActions,
  resolutionPolicyFor,
} from "~/entity/fields/field-resolution";
import { compactFieldText } from "~/entity/fields/field-text";
import { useEntityMetadata } from "~/entity/metadata";
import { DateDisplay } from "~/ui/common/date-display";
import { Button } from "~/ui/primitives/button";

import { UpdatingDot } from "./value-mark";
import { ExplanationEntityLink, ReadableExplanationValue } from "./why-value";

export function DecisionValue({
  entity,
  field,
  value,
}: {
  entity?: Entity;
  field?: string;
  value: unknown;
}) {
  return entity && field ? (
    <EntityDecisionValue entity={entity} field={field} value={value} />
  ) : (
    <ReadableExplanationValue value={z.json().parse(value)} />
  );
}

function EntityDecisionValue({
  entity,
  field,
  value,
}: {
  entity: Entity;
  field: string;
  value: unknown;
}) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const model = metadata.fields.fields.find(
    (candidate) => candidate.key === field,
  );
  const label = model
    ? compactFieldText(queryClient, entity, { [model.key]: value }, model)
    : null;
  return label && label !== value ? (
    <span className="break-words">{label}</span>
  ) : (
    <ReadableExplanationValue value={z.json().parse(value)} />
  );
}

function DecisionResult({
  result,
  work,
  entity,
  field,
}: {
  result: FieldExplanationOutput["envelope"]["result"];
  work: FieldExplanationOutput["envelope"]["work"];
  entity: Entity;
  field: string;
}) {
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
  const decision = fieldDecisionOf({ result });
  const labels = resolutionPolicyFor(queryClient, entity, field)?.labels;
  const emptyLabel = fieldEmptyLabel({ result, work }, labels);
  if (emptyLabel !== null)
    return <span className="text-xs text-muted-foreground">{emptyLabel}</span>;
  if (!decision || decision.outcome.kind !== "value") return null;
  return (
    <DecisionValue
      entity={entity}
      field={field}
      value={decision.outcome.value}
    />
  );
}

/** The envelope decides the winning level; clients never rerun precedence.
 * Resolution evidence owns its structured value instead of duplicating wire fields. */
export function DecisionChain({
  data,
  pending,
  onSet,
}: {
  data: FieldExplanationOutput;
  pending?: ReactNode;
  onSet?: () => void;
}) {
  const queryClient = useQueryClient();
  useEntityMetadata(data.subject.entityKind);
  const decision = fieldDecisionOf(data.envelope);
  const noneLabel = fieldNoneLabel(
    resolutionPolicyFor(queryClient, data.subject.entityKind, data.field)
      ?.labels,
  );
  const provenance = decision?.provenance;
  const source =
    provenance?.kind === "inherited" || provenance?.kind === "default"
      ? provenance.source
      : null;
  return (
    <div className="grid gap-3">
      <section aria-label="Effective result" className="grid gap-1">
        <h3 className="text-xs font-medium">Effective result</h3>
        <DecisionResult
          result={data.envelope.result}
          work={data.envelope.work}
          entity={data.subject.entityKind}
          field={data.field}
        />
        {source &&
        (!data.resolutionEvidence || data.envelope.result.kind === "cached") ? (
          <p className="text-xs text-muted-foreground">
            From{" "}
            <ExplanationEntityLink
              entity={source.entityKind}
              id={source.entityId}
              name={source.name}
            />
          </p>
        ) : null}
      </section>
      {data.envelope.result.kind === "cached" ? (
        <section
          aria-label="Current input comparison"
          className="grid gap-1 text-xs"
        >
          {data.comparison.kind === "available" ? (
            <p>
              Stored{" "}
              <DecisionResult
                result={data.envelope.result}
                work={data.envelope.work}
                entity={data.subject.entityKind}
                field={data.field}
              />
              {" → live "}
              <DecisionResult
                result={data.comparison.result}
                work={data.envelope.work}
                entity={data.subject.entityKind}
                field={data.field}
              />
            </p>
          ) : (
            <p>Live comparison unavailable: {data.comparison.reason}</p>
          )}
        </section>
      ) : null}
      {data.envelope.current.assignment !== null ||
      data.envelope.current.controls.kind === "editable" ? (
        <section aria-label="Your choice" className="grid gap-1">
          <h3 className="text-xs font-medium">Your choice</h3>
          <div className="text-xs">
            {data.envelope.current.assignment?.kind === "value" ? (
              <div className="grid gap-1">
                <span className="text-muted-foreground">
                  {data.envelope.current.assignment.ownership.kind ===
                  "automatic"
                    ? "Automatic assignment"
                    : "Set here"}
                </span>
                <DecisionValue
                  entity={data.subject.entityKind}
                  field={data.field}
                  value={data.envelope.current.assignment.value}
                />
              </div>
            ) : (
              <span className="text-muted-foreground">
                {data.envelope.current.assignment?.kind === "none"
                  ? noneLabel
                  : "Following inherited values"}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {onSet && data.envelope.current.controls.kind === "editable" ? (
              <Button variant="link" size="xs" onClick={onSet}>
                Set value…
              </Button>
            ) : null}
            <FieldResolutionEntityActions
              entity={data.subject.entityKind}
              id={data.subject.entityId}
              field={data.field}
              resolution={data.envelope}
            />
          </div>
          {data.envelope.current.controls.kind === "editable" &&
          data.envelope.current.controls.reset.kind === "available" &&
          data.envelope.current.controls.reset.preview.kind === "ready" ? (
            <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
              <span>With inherited values:</span>
              <DecisionValue
                entity={data.subject.entityKind}
                field={data.field}
                value={fieldValueOf({
                  result: data.envelope.current.controls.reset.preview.result,
                })}
              />
            </div>
          ) : null}
        </section>
      ) : null}
      {data.envelope.result.kind === "cached" ? (
        <p className="text-xs text-muted-foreground">
          Published snapshot sources describe the cached revision. Resolution
          evidence below describes current inputs and can differ from that
          revision.
        </p>
      ) : null}
      {pending}
    </div>
  );
}

export function DerivedFreshness({
  envelope,
  context: _context,
}: {
  envelope: FieldExplanationOutput["envelope"];
  context?: Pick<FieldExplanationOutput, "subject" | "field">;
}) {
  return _context ? (
    <ContextualDerivedFreshness envelope={envelope} context={_context} />
  ) : (
    <Freshness envelope={envelope} />
  );
}

function ContextualDerivedFreshness({
  envelope,
  context,
}: {
  envelope: FieldExplanationOutput["envelope"];
  context: Pick<FieldExplanationOutput, "subject" | "field">;
}) {
  const metadata = useEntityMetadata(context.subject.entityKind);
  const field = metadata.fields.fields.find(
    (candidate) => candidate.key === context.field,
  );
  return (
    <Freshness
      envelope={envelope}
      contextual={Boolean(
        field && "storedProjection" in field && field.storedProjection,
      )}
    />
  );
}

function Freshness({
  envelope,
  contextual = false,
}: {
  envelope: FieldExplanationOutput["envelope"];
  contextual?: boolean;
}) {
  const result = envelope.result;
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      {result.kind === "cached" ? (
        <p>
          {contextual
            ? result.freshness === "stale"
              ? "Stale facts"
              : "Cached facts"
            : result.freshness === "stale"
              ? "Stale result"
              : "Cached result"}{" "}
          · <DateDisplay timestamp={result.computedAt} />
        </p>
      ) : null}
      {envelope.work.kind === "pending" ? (
        <span>
          <UpdatingDot /> Updating
        </span>
      ) : null}
      {envelope.work.kind === "waiting" ? <p>{envelope.work.reason}</p> : null}
      {envelope.work.kind === "failed" ? (
        <p role="alert" className="break-words text-destructive">
          {envelope.work.error}
        </p>
      ) : null}
    </div>
  );
}
