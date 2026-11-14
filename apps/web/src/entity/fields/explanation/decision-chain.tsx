import type { Entity } from "@cubby/schemas/entity";
import {
  fieldDecisionOf,
  fieldResult,
  fieldValueOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import {
  FIELD_RELEASED_LABEL,
  FIELD_RESET_LABEL,
  FIELD_STALE_LABEL,
  FIELD_WAITING_LABEL,
  fieldDecidingLine,
  fieldEmptyLabel,
  fieldNoneLabel,
  machineryResetPendingNote,
} from "@cubby/schemas/field-envelope-presentation";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import type { Machinery } from "@cubby/schemas/kernel/machinery";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  FieldResolutionEntityActions,
  resolutionPolicyFor,
} from "~/entity/fields/field-resolution";
import { compactFieldText } from "~/entity/fields/field-text";
import { useEntityMetadata } from "~/entity/metadata";
import { authClient } from "~/lib/auth-client";
import {
  DecisionLevels,
  type DecisionLevel,
} from "~/ui/derived/decision-levels";
import { Button } from "~/ui/primitives/button";
import { DateDisplay } from "~/ui/values/date-display";

import { FieldOriginLine, writerName } from "./field-origin";
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

/** The machinery read's reset preview is a field result. */
const previewResult = fieldResult(z.json());

/** The deciding level from the server's envelope; clients never rerun precedence. */
function decidingLevel(
  envelope: ReadableFieldEnvelope | null,
): DecisionLevel | undefined {
  if (!envelope) return undefined;
  if (envelope.result.kind === "missing") return "waiting";
  const decision = fieldDecisionOf(envelope);
  switch (decision?.provenance?.kind) {
    case "own":
      return "own";
    case "inherited":
    case "default":
      return "source";
    case "computed":
    case "allocated":
      return "cubby";
    default:
      return decision?.outcome.kind === "empty" &&
        decision.outcome.reason === "explicit_none"
        ? "own"
        : undefined;
  }
}

function ResultValue({
  envelope,
  entity,
  field,
}: {
  envelope: ReadableFieldEnvelope;
  entity: Entity;
  field: string;
}) {
  const queryClient = useQueryClient();
  const labels = resolutionPolicyFor(queryClient, entity, field)?.labels;
  const empty = fieldEmptyLabel(envelope, labels);
  if (empty !== null)
    return <span className="text-muted-foreground">{empty}</span>;
  const decision = fieldDecisionOf(envelope);
  if (decision?.outcome.kind !== "value") return null;
  return (
    <DecisionValue
      entity={entity}
      field={field}
      value={decision.outcome.value}
    />
  );
}

/** The own level: the value set here, who set it, and the field's actions. */
function OwnLevel({
  entity,
  id,
  field,
  envelope,
  data,
  deciding,
  machineryPreview,
  onSet,
}: {
  entity: Entity;
  id: string;
  field: string;
  envelope: ReadableFieldEnvelope;
  data?: FieldExplanationOutput;
  deciding: boolean;
  /** The field scope's reset preview, preferred when the entity has machinery. */
  machineryPreview?: Machinery["resetPreview"];
  onSet?: () => void;
}) {
  const queryClient = useQueryClient();
  const { assignment, controls } = envelope.current;
  const labels = resolutionPolicyFor(queryClient, entity, field)?.labels;
  if (assignment === null && controls.kind !== "editable") return null;
  const origin = data?.origin ?? null;
  const kernelPreview = machineryPreview
    ? previewResult.safeParse(machineryPreview.result)
    : null;
  const resetPreview = kernelPreview?.success
    ? kernelPreview.data
    : controls.kind === "editable" &&
        controls.reset.kind === "available" &&
        controls.reset.preview.kind === "ready"
      ? controls.reset.preview.result
      : null;
  const pendingNote = machineryPreview
    ? machineryResetPendingNote(machineryPreview.pendingAnswers)
    : null;
  return (
    <div className="grid gap-1">
      {assignment?.kind === "value" ? (
        <DecisionValue entity={entity} field={field} value={assignment.value} />
      ) : assignment?.kind === "none" ? (
        <span>{fieldNoneLabel(labels)}</span>
      ) : deciding ? (
        <ResultValue envelope={envelope} entity={entity} field={field} />
      ) : null}
      {data && origin ? (
        <FieldOriginLine
          data={data}
          origin={origin}
          resetOffered={
            controls.kind === "editable" && controls.reset.kind === "available"
          }
          guess={
            origin.guess ? (
              <DecisionValue
                entity={entity}
                field={field}
                value={origin.guess.value}
              />
            ) : null
          }
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {onSet && controls.kind === "editable" ? (
          <Button variant="link" size="xs" onClick={onSet}>
            Set value…
          </Button>
        ) : null}
        <FieldResolutionEntityActions
          entity={entity}
          id={id}
          field={field}
          resolution={envelope}
        />
      </div>
      {resetPreview ? (
        <p className="flex flex-wrap gap-1 text-muted-foreground">
          <span>{FIELD_RESET_LABEL}:</span>
          <DecisionValue
            entity={entity}
            field={field}
            value={fieldValueOf({ result: resetPreview })}
          />
          {pendingNote ? <span>{pendingNote}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Why this value as the field scope of the machinery panel: one chain in
 * precedence order (own, source, Cubby, waiting), the same rows at every
 * load state, with the deciding level filled once the envelope is known.
 * The one reset action is "Let Cubby decide", with its exact preview.
 */
export function FieldChain({
  entity,
  id,
  field,
  envelope,
  data,
  machinery,
  pending,
  onSet,
}: {
  entity: Entity;
  id: string;
  field: string;
  /** The field's envelope from the row or the explanation, whichever is loaded. */
  envelope: ReadableFieldEnvelope | null;
  /** The loaded explanation; absent while it loads or after it fails. */
  data?: FieldExplanationOutput;
  /** The field scope of the record's machinery, when its entity has one. */
  machinery?: Machinery | null;
  pending?: ReactNode;
  onSet?: () => void;
}) {
  const session = authClient.useSession();
  const deciding = decidingLevel(envelope);
  const decision = envelope ? fieldDecisionOf(envelope) : null;
  const provenance = decision?.provenance;
  const source =
    provenance?.kind === "inherited" || provenance?.kind === "default"
      ? provenance.source
      : null;
  const assignment = envelope?.current.assignment ?? null;
  const origin = data?.origin ?? null;
  const by = origin?.writer
    ? writerName(origin.writer, session.data?.user.name)
    : null;
  const ownTitle =
    assignment?.kind === "none"
      ? fieldDecidingLine({ kind: "none", by: by ?? "you" })
      : assignment?.kind === "value" && by
        ? fieldDecidingLine({ kind: "set", by })
        : assignment?.kind === "inherit"
          ? FIELD_RELEASED_LABEL
          : "Set here";
  const result = envelope?.result;
  const firstGap = machinery?.gaps.items[0];
  const rows: Parameters<typeof DecisionLevels>[0]["rows"][number][] = [
    {
      level: "own",
      title: ownTitle,
      children: envelope ? (
        <OwnLevel
          entity={entity}
          id={id}
          field={field}
          envelope={envelope}
          data={data}
          deciding={deciding === "own"}
          machineryPreview={machinery?.resetPreview}
          onSet={onSet}
        />
      ) : null,
    },
    {
      level: "source",
      title: source
        ? fieldDecidingLine({
            kind: "source",
            source: source.name ?? source.entityId,
          })
        : "From another record",
      children:
        source && envelope ? (
          <div className="grid gap-1">
            <ExplanationEntityLink
              entity={source.entityKind}
              id={source.entityId}
              name={source.name}
            />
            {deciding === "source" ? (
              <ResultValue envelope={envelope} entity={entity} field={field} />
            ) : null}
          </div>
        ) : null,
    },
    {
      level: "cubby",
      title: fieldDecidingLine({ kind: "cubby" }),
      children:
        deciding === "cubby" && envelope ? (
          <div className="grid gap-1">
            <ResultValue envelope={envelope} entity={entity} field={field} />
            {result?.kind === "cached" ? (
              <p className="text-muted-foreground">
                <DateDisplay timestamp={result.computedAt} />
                {result.freshness === "stale"
                  ? ` · ${FIELD_STALE_LABEL}`
                  : null}
              </p>
            ) : null}
          </div>
        ) : null,
    },
    {
      level: "waiting",
      title: firstGap
        ? fieldDecidingLine({
            kind: "waiting",
            input: firstGap.input,
            actor: firstGap.actor,
          })
        : FIELD_WAITING_LABEL,
    },
    ...(pending
      ? [
          {
            level: "pending" as const,
            title: "Cubby's suggestion",
            children: pending,
          },
        ]
      : []),
  ];
  return <DecisionLevels deciding={deciding} rows={rows} />;
}
