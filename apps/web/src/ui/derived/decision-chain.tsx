import type { Entity } from "@cubby/schemas/entity";
import { entitySchema } from "@cubby/schemas/entity";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { capitalize } from "@cubby/shared";
import { isEqual } from "es-toolkit";
import type { ReactNode } from "react";

import { enumFieldLabel } from "~/entity/display/enum-field-display";
import { FieldResolutionEntityActions } from "~/entity/fields/field-resolution";
import { formatRelative } from "~/lib/date-format";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";

import { DecisionLevels } from "./decision-levels";
import { resolutionDecidedBy } from "./meta";
import { UpdatingDot } from "./value-mark";
import { ExplanationEntityLink, ReadableExplanationValue } from "./why-value";

export function DecisionValue({
  entity,
  field,
  value,
}: {
  entity?: Entity;
  field?: string;
  value: FieldExplanationOutput["value"];
}) {
  const label =
    entity && field && typeof value === "string"
      ? enumFieldLabel(entity, field, value)
      : null;
  return label ? (
    <span className="break-words">{label}</span>
  ) : (
    <ReadableExplanationValue value={value} />
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
  const decided =
    data.derived?.meta.decidedBy ??
    (data.resolution ? resolutionDecidedBy(data.resolution) : null);
  const winner =
    decided?.level === "suggested"
      ? decided.auto
        ? "pending"
        : "accepted"
      : decided?.level;
  const source = decided?.level === "inherited" ? decided.source : null;
  const sourceEntity = source ? entitySchema.safeParse(source.entity) : null;
  return (
    <>
      <DecisionLevels deciding={winner}>
        {(level) => (
          <>
            {level === "inherited" && source && sourceEntity?.success ? (
              <div className="flex flex-wrap items-center gap-1">
                <span>from</span>
                <ExplanationEntityLink
                  entity={sourceEntity.data}
                  id={source.id}
                  name={source.label}
                />
              </div>
            ) : null}
            {level === winner && !data.resolutionEvidence ? (
              <div className="text-foreground">
                <DecisionValue
                  entity={data.subject.entityKind}
                  field={data.field}
                  value={data.value}
                />
              </div>
            ) : null}
            {data.resolution &&
            ((level === "inherited" && data.resolution.canReset) ||
              (level === "own" && !data.resolution.canReset)) ? (
              <div>
                <FieldResolutionEntityActions
                  entity={data.subject.entityKind}
                  id={data.subject.entityId}
                  field={data.field}
                  resolution={data.resolution}
                />
              </div>
            ) : null}
            {level === "own" && onSet ? (
              <Button variant="link" size="xs" onClick={onSet}>
                Set…
              </Button>
            ) : null}
            {level === "own"
              ? data.actions.map((action) => (
                  <div
                    key={`${action.target.entityKind}:${action.target.entityId}`}
                    className="flex flex-wrap items-center gap-1"
                  >
                    <span>
                      {action.target.entityId === data.subject.entityId
                        ? "Set…"
                        : action.label}
                    </span>
                    <ExplanationEntityLink
                      entity={action.target.entityKind}
                      id={action.target.entityId}
                    />
                  </div>
                ))
              : null}
            {level === "pending" ? pending : null}
          </>
        )}
      </DecisionLevels>
      {data.resolution?.mode === "allocated" ? (
        <div className="grid gap-1 text-xs">
          <p className="font-medium">
            {data.resolutionEvidence?.outcome &&
            data.resolutionEvidence.outcome !== "resolved"
              ? { mixed: "Mixed", unset: "Not set", blocked: "Blocked" }[
                  data.resolutionEvidence.outcome
                ]
              : "Allocated"}
          </p>
          <p className="text-muted-foreground">
            {capitalize(data.resolution.source)}
          </p>
        </div>
      ) : null}
      {!data.resolutionEvidence &&
      (winner === "computed" || (!decided && data.value !== null)) ? (
        <div className="flex items-center gap-2 text-xs">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-foreground"
          />
          <span className="font-semibold">Computed</span>
          <DecisionValue
            entity={data.subject.entityKind}
            field={data.field}
            value={data.value}
          />
        </div>
      ) : null}
    </>
  );
}

export function DerivedFreshness({
  derived,
  context,
}: {
  derived: NonNullable<FieldExplanationOutput["derived"]>;
  context?: Pick<FieldExplanationOutput, "subject" | "field">;
}) {
  const now = useDisplayNow() ?? Date.now();
  const updating =
    derived.meta.state === "stale" || derived.meta.state === "waiting";
  const same = derived.live !== null && isEqual(derived.stored, derived.live);
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-1">
        {same ? (
          <>
            As of{" "}
            {derived.meta.asOf ? (
              <time dateTime={derived.meta.asOf}>
                {formatRelative(new Date(derived.meta.asOf), now)}
              </time>
            ) : (
              "now"
            )}{" "}
            · live: same
          </>
        ) : (
          <>
            Stored{" "}
            <DecisionValue
              entity={context?.subject.entityKind}
              field={context?.field}
              value={derived.stored}
            />{" "}
            → live{" "}
            {derived.live === null ? (
              "unavailable"
            ) : (
              <DecisionValue
                entity={context?.subject.entityKind}
                field={context?.field}
                value={derived.live}
              />
            )}
          </>
        )}
        {updating ? (
          <Badge variant="secondary">
            <UpdatingDot />
            Updating
          </Badge>
        ) : null}
      </div>
      {derived.meta.state === "failed" && derived.meta.error ? (
        <p role="alert" className="break-words text-destructive">
          {derived.meta.error}
        </p>
      ) : null}
    </div>
  );
}
