import type { Entity } from "@cubby/schemas/entity";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { parseShortcode } from "@cubby/shared";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import type { ReactNode } from "react";
import { z } from "zod";

import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { enumFieldLabel } from "~/entities/enum-field-display";

import {
  ExplanationEntityLink,
  ReadableExplanationValue,
  type ExplanationValue,
} from "./field-explanation";

const sentenceCase = (value: string): string =>
  value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);

const nounFor = (entity: Entity) =>
  entitySummary[entity].singular.toLowerCase();

/** A resolution value: a linked record, a labeled enum option, or the same
 * generic rendering the rest of the popover already uses. */
function ResolutionValue({
  entity,
  field,
  value,
}: {
  entity: Entity;
  field: string;
  value: ExplanationValue;
}) {
  if (value === null) return <NoneValue />;
  const text = z.string().safeParse(value);
  if (text.success) {
    const reference = parseShortcode(text.data);
    if (reference)
      return (
        <ExplanationEntityLink
          entity={reference.type}
          id={reference.shortcode}
        />
      );
    const label = enumFieldLabel(entity, field, text.data);
    return <span className="break-words">{label ?? text.data}</span>;
  }
  return <ReadableExplanationValue value={value} />;
}

function InEffectRow({
  entity,
  field,
  resolution,
  noun,
}: {
  entity: Entity;
  field: string;
  resolution: FieldResolution;
  noun: string;
}) {
  if (resolution.mode === "explicit") {
    const redundant = resolution.matchesFallback;
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ResolutionValue
          entity={entity}
          field={field}
          value={resolution.value}
        />
        <Badge variant={redundant ? "warning" : "secondary"}>
          {redundant ? (
            <WarningIcon aria-hidden="true" />
          ) : (
            <ArrowCounterClockwiseIcon aria-hidden="true" />
          )}
          Override on this {noun}
        </Badge>
      </span>
    );
  }
  if (resolution.mode === "allocated") {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1 break-words">
        <ResolutionValue
          entity={entity}
          field={field}
          value={resolution.value}
        />
        <span className="break-words text-muted-foreground">
          · {sentenceCase(resolution.source)}
        </span>
        {resolution.sourceEntity ? (
          <ExplanationEntityLink
            entity={resolution.sourceEntity.entityKind}
            id={resolution.sourceEntity.entityId}
            name={resolution.sourceEntity.name}
          />
        ) : null}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1 break-words">
      <ResolutionValue entity={entity} field={field} value={resolution.value} />
      <span className="break-words text-muted-foreground">
        · {sentenceCase(resolution.source)}
      </span>
      {resolution.sourceEntity ? (
        <ExplanationEntityLink
          entity={resolution.sourceEntity.entityKind}
          id={resolution.sourceEntity.entityId}
          name={resolution.sourceEntity.name}
        />
      ) : null}
    </span>
  );
}

/** The structured, per-field-resolution replacement for the generic
 * "Current value" block: what wins, and — for an override — what clearing it
 * would leave behind. Purely a rendering of the server's typed
 * `FieldResolution`; it never recomputes precedence. */
export function ResolutionExplanation({
  entity,
  field,
  resolution,
  evidence,
}: {
  entity: Entity;
  field: string;
  resolution: FieldResolution;
  evidence?: FieldExplanationOutput["resolutionEvidence"];
}) {
  const noun = nounFor(entity);
  const rows: Array<{ label: string; content: ReactNode }> = [
    {
      label: "In effect",
      content: (
        <InEffectRow
          entity={entity}
          field={field}
          resolution={resolution}
          noun={noun}
        />
      ),
    },
  ];

  if (resolution.mode === "explicit" || resolution.mode === "none") {
    rows.push({
      label: "Without the override",
      content:
        resolution.fallbackValue === null ? (
          <span className="text-muted-foreground">Nothing to inherit</span>
        ) : (
          <span className="grid gap-1">
            <ResolutionValue
              entity={entity}
              field={field}
              value={resolution.fallbackValue}
            />
            {evidence?.fallbackSource ? (
              <span className="text-xs text-muted-foreground">
                From{" "}
                <ExplanationEntityLink
                  entity={evidence.fallbackSource.entityKind}
                  id={evidence.fallbackSource.entityId}
                  name={evidence.fallbackSource.name}
                />
              </span>
            ) : null}
            {resolution.matchesFallback ? (
              <span className="text-xs text-muted-foreground">
                Same value — the override is redundant.
              </span>
            ) : null}
          </span>
        ),
    });
  } else if (
    resolution.mode === "allocated" &&
    resolution.storedValue !== null
  ) {
    rows.push({
      label: `Stored on this ${noun}`,
      content: (
        <ResolutionValue
          entity={entity}
          field={field}
          value={resolution.storedValue}
        />
      ),
    });
  } else if (resolution.mode === "inherit") {
    const linkedNoun = resolution.sourceEntity
      ? nounFor(resolution.sourceEntity.entityKind)
      : null;
    rows.push({
      label: `Stored on this ${noun}`,
      content: (
        <span className="grid gap-1">
          <NoneValue />
          <span className="text-xs text-muted-foreground">
            {linkedNoun
              ? `Change it on the linked ${linkedNoun}, or set an override here.`
              : `Set an override on this ${noun} to change it.`}
          </span>
        </span>
      ),
    });
  }

  if (evidence?.hierarchy.length)
    rows.push({
      label: "Hierarchy",
      content: (
        <ol className="grid gap-2">
          {evidence.hierarchy.map((source) => (
            <li
              key={`${source.entity?.entityId ?? source.label}:${source.label}`}
              className="grid gap-1 text-xs"
            >
              <span className="text-muted-foreground">{source.label}</span>
              {source.entity ? (
                <ExplanationEntityLink
                  entity={source.entity.entityKind}
                  id={source.entity.entityId}
                  name={
                    z.object({ name: z.string() }).safeParse(source.value).data
                      ?.name
                  }
                />
              ) : null}
              <ReadableExplanationValue value={source.value} />
            </li>
          ))}
        </ol>
      ),
    });

  return (
    <dl className="grid gap-3">
      {rows.map((row) => (
        <div key={row.label} className="grid gap-1 text-sm">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0">{row.content}</dd>
        </div>
      ))}
    </dl>
  );
}
