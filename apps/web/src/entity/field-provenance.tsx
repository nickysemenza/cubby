import type { Entity } from "@cubby/schemas/entity";
import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import { localRelationshipByKey } from "@cubby/schemas/entity-manifest";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import type React from "react";

import { EntityIcon, entityLabel, entityPluralLabel } from "./entities";

type ProvenanceSource = EntityFieldProvenance["sources"][number];

/** Build specialist-column metadata from the same declared relationship graph. */
export function relationshipFieldProvenance(
  sourceEntity: Entity,
  relationKey: string,
  kind: "derived" | "reference" | "relation" = "derived",
): EntityFieldProvenance {
  const relation = localRelationshipByKey(sourceEntity, relationKey);
  return {
    kind,
    sources: [
      {
        entity: relation.target,
        label: null,
        relation: relation.key,
      },
    ],
  };
}

/** Label a specialist projection whose source is not a Cubby entity relation. */
export function labeledFieldProvenance(
  label: string,
  kind: "derived" | "relation" = "derived",
): EntityFieldProvenance {
  return {
    kind,
    sources: [{ entity: null, label, relation: null }],
  };
}

/** Name a Cubby entity source that has no executable owning-record relation. */
export function entityFieldProvenance(
  entity: Entity,
  kind: "derived" | "reference" = "derived",
): EntityFieldProvenance {
  return {
    kind,
    sources: [{ entity, label: null, relation: null }],
  };
}

/** Direct references keep their own links and pickers; only relationship-backed
 * projections and managed inputs open the generic related-record workbench. */
export function isInspectableFieldProvenance(
  provenance: EntityFieldProvenance | null | undefined,
): provenance is EntityFieldProvenance {
  return Boolean(
    provenance &&
    provenance.kind !== "reference" &&
    provenance.sources.some((source) => source.relation !== null),
  );
}

function sourceName(
  source: ProvenanceSource,
  kind: EntityFieldProvenance["kind"],
): string {
  if (source.label !== null) return source.label;
  if (source.entity !== null)
    return kind === "reference"
      ? entityLabel(source.entity)
      : entityPluralLabel(source.entity);
  return source.relation ?? "source";
}

/** Formats the compact, user-facing explanation for a field's origin. */
export function formatFieldProvenance(
  provenance: EntityFieldProvenance,
): string {
  const names = provenance.sources
    .map((source) => sourceName(source, provenance.kind))
    .join(" + ");
  switch (provenance.kind) {
    case "reference":
      return `Linked to ${names}`;
    case "relation":
      return `Managed through ${names}`;
    case "derived":
      return `From ${names}`;
  }
}

export interface FieldProvenanceProps extends Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "children"
> {
  provenance: EntityFieldProvenance | null | undefined;
  /** Source icons only, phrase on hover/focus — for one-line table headers. */
  compact?: boolean;
}

/** A quiet, non-interactive source line for dense field surfaces. */
export function FieldProvenance({
  provenance,
  compact = false,
  className,
  ...props
}: FieldProvenanceProps) {
  if (!provenance) return null;

  const phrase = formatFieldProvenance(provenance);
  const iconEntities = provenance.sources.flatMap((source) =>
    source.entity ? [source.entity] : [],
  );
  if (compact) {
    return (
      <span
        {...props}
        tabIndex={props.tabIndex ?? 0}
        role="note"
        aria-label={phrase}
        title={phrase}
        data-field-provenance
        className={[
          "inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {iconEntities.length === 0 ? (
          // A labelled source ("Image storage") has no entity mark; a generic
          // source glyph keeps its phrase discoverable.
          <LinkIcon aria-hidden="true" className="size-3" />
        ) : (
          iconEntities.map((entity) => (
            <EntityIcon
              key={entity}
              entity={entity}
              aria-hidden="true"
              className="size-3"
            />
          ))
        )}
      </span>
    );
  }
  const focusableForDisclosure =
    provenance.sources.length > 1 || phrase.length > 32;
  return (
    <span
      {...props}
      tabIndex={props.tabIndex ?? (focusableForDisclosure ? 0 : undefined)}
      role="note"
      aria-label={phrase}
      title={phrase}
      data-field-provenance
      className={[
        "flex min-w-0 items-center gap-1 text-xs text-muted-foreground",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {provenance.sources.map((source, index) => (
        <span
          key={`${source.entity ?? ""}:${source.label ?? ""}:${source.relation ?? ""}`}
        >
          {source.entity ? (
            <EntityIcon
              entity={source.entity}
              aria-hidden="true"
              className="mr-0.5 inline-block size-3 shrink-0 align-[-0.125em]"
            />
          ) : null}
          {index > 0 ? " + " : null}
          <span className="sr-only">{sourceName(source, provenance.kind)}</span>
        </span>
      ))}
      <span className="min-w-0 truncate">{phrase}</span>
    </span>
  );
}
