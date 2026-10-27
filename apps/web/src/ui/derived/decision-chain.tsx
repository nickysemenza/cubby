import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { fieldDecisionOf, fieldValueOf } from "@cubby/schemas/field-envelope";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import type { ReactNode } from "react";
import { z } from "zod";

import { FieldResolutionEntityActions } from "~/entity/fields/field-resolution";
import { compactFieldText } from "~/entity/fields/field-text";
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
  const model =
    entity && field
      ? entityFieldModels[entity].fields.find(
          (candidate) => candidate.key === field,
        )
      : null;
  const label =
    entity && model
      ? compactFieldText(entity, { [model.key]: value }, model)
      : null;
  return label && label !== value ? (
    <span className="break-words">{label}</span>
  ) : (
    <ReadableExplanationValue value={z.json().parse(value)} />
  );
}

function DecisionResult({
  result,
  entity,
  field,
}: {
  result: FieldExplanationOutput["envelope"]["result"];
  entity: Entity;
  field: string;
}) {
  const decision = fieldDecisionOf({ result });
  if (!decision)
    return <span className="text-xs text-muted-foreground">Updating…</span>;
  if (decision.outcome.kind === "empty")
    return (
      <span className="text-xs text-muted-foreground">
        {
          {
            explicit_none: "None",
            unset: "Not set",
            blocked: "Blocked",
            mixed: "Mixed",
            not_applicable: "Not applicable",
          }[decision.outcome.reason]
        }
      </span>
    );
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
  const decision = fieldDecisionOf(data.envelope);
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
                entity={data.subject.entityKind}
                field={data.field}
              />
              {" → live "}
              <DecisionResult
                result={data.comparison.result}
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
                  ? "None"
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
          Sources below describe current inputs. The cached result retains its
          recorded provenance until recomputed.
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
  const result = envelope.result;
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      {result.kind === "cached" ? (
        <p>
          {result.freshness === "stale" ? "Stale result" : "Cached result"} ·{" "}
          <DateDisplay timestamp={result.computedAt} />
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
