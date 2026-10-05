import type { Entity } from "@cubby/schemas/entity";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { capitalize, parseShortcode } from "@cubby/shared";
import type { ReactNode } from "react";
import { z } from "zod";

import { enumFieldLabel } from "~/entity/enum-field-display";
import { cn } from "~/lib/utils";
import { Badge, type BadgeVariant } from "~/ui/primitives/badge";
import { NoneValue } from "~/ui/primitives/none-value";

import {
  ExplanationEntityLink,
  ReadableExplanationValue,
  type ExplanationValue,
} from "./field-explanation";
import { resolutionState, type ResolutionTone } from "./field-resolution";

type Evidence = NonNullable<FieldExplanationOutput["resolutionEvidence"]>;

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

const toneBadge = {
  set: "outline",
  override: "secondary",
  redundant: "warning",
  none: "outline",
  inherit: "secondary",
  allocated: "secondary",
} as const satisfies Record<ResolutionTone, BadgeVariant>;

function ResolutionHeadline({
  entity,
  field,
  resolution,
}: {
  entity: Entity;
  field: string;
  resolution: FieldResolution;
}) {
  const { tone, label, Icon } = resolutionState(resolution);
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="min-w-0 text-base font-semibold break-words">
        <ResolutionValue
          entity={entity}
          field={field}
          value={resolution.value}
        />
      </span>
      <Badge variant={toneBadge[tone]}>
        <Icon aria-hidden="true" />
        {label}
      </Badge>
    </div>
  );
}

/** Ladder nodes from `loadFieldResolutionEvidence`: one ancestor's own
 * assignment. Spending-category nodes carry `{ mode, category }`. */
const ladderNodeSchema = z.object({
  name: z.string(),
  value: z.json(),
  assigned: z.boolean(),
});
const spendingBindingSchema = z.object({
  mode: z.string(),
  category: z.string().nullable(),
});

type LadderRole = "wins" | "unset" | "shadowed";
type LadderRow = {
  key: string;
  entity: Evidence["hierarchy"][number]["entity"];
  name: string | null;
  value: ExplanationValue;
  assigned: boolean;
};

function ladderRow(
  source: Evidence["hierarchy"][number],
  index: number,
): LadderRow {
  const node = ladderNodeSchema.safeParse(source.value);
  const key = `${source.entity?.entityId ?? source.label}:${index}`;
  if (!node.success)
    return {
      key,
      entity: source.entity,
      name: null,
      value: source.value,
      assigned: source.value !== null,
    };
  const binding = spendingBindingSchema.safeParse(node.data.value);
  return {
    key,
    entity: source.entity,
    name: node.data.name,
    value: binding.success
      ? binding.data.mode === "blocked"
        ? "Blocked"
        : binding.data.category
      : node.data.value,
    assigned: node.data.assigned,
  };
}

/** The level that supplies the value: the inherited source, else the subject
 * itself when it is part of its own ancestry. -1 when the subject sits
 * outside this ladder (an expense over its product's categories). */
function winnerIndex(
  rows: LadderRow[],
  resolution: FieldResolution,
  subjectId: string | undefined,
): number {
  const winner =
    resolution.mode === "inherit" || resolution.mode === "allocated"
      ? resolution.sourceEntity?.entityId
      : subjectId;
  return winner === undefined
    ? -1
    : rows.findIndex((row) => row.entity?.entityId === winner);
}

const roleLabel = {
  wins: "wins",
  unset: "not set",
  shadowed: "shadowed",
} as const satisfies Record<LadderRole, string>;

function ResolutionLadder({
  entity,
  field,
  id,
  resolution,
  hierarchy,
}: {
  entity: Entity;
  field: string;
  id: string | undefined;
  resolution: FieldResolution;
  hierarchy: Evidence["hierarchy"];
}) {
  const groups = new Map<string, LadderRow[]>();
  hierarchy.forEach((source, index) => {
    const rows = groups.get(source.label) ?? [];
    rows.push(ladderRow(source, index));
    groups.set(source.label, rows);
  });
  return (
    <div className="grid gap-2">
      {[...groups].map(([label, rows]) => {
        const winner = winnerIndex(rows, resolution, id);
        return (
          <div key={label} className="grid gap-1">
            {groups.size > 1 ? (
              <span className="text-[11px] text-muted-foreground">{label}</span>
            ) : null}
            <ol className="grid border-s border-border ps-2">
              {rows.map((row, index) => {
                const role: LadderRole =
                  index === winner
                    ? "wins"
                    : row.assigned
                      ? "shadowed"
                      : "unset";
                const self = id !== undefined && row.entity?.entityId === id;
                return (
                  <li
                    key={row.key}
                    data-role={role}
                    className={cn(
                      "relative grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 rounded-sm px-1.5 py-1 text-xs",
                      "before:absolute before:-start-[calc(0.5rem+3px)] before:top-2.5 before:size-1.5 before:rounded-full before:bg-border",
                      role === "wins" && "bg-accent before:bg-primary",
                      role !== "wins" && "text-muted-foreground",
                    )}
                  >
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {self || !row.entity ? (
                          (row.name ?? "This record")
                        ) : (
                          <ExplanationEntityLink
                            entity={row.entity.entityKind}
                            id={row.entity.entityId}
                            name={row.name}
                          />
                        )}
                      </span>
                      {self ? (
                        <span className="shrink-0 text-[10px] tracking-wide uppercase">
                          this
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-baseline gap-2 justify-self-end">
                      <span
                        className={cn(
                          "max-w-32 truncate",
                          role === "shadowed" && "line-through",
                        )}
                      >
                        {row.assigned ? (
                          <ResolutionValue
                            entity={entity}
                            field={field}
                            value={row.value}
                          />
                        ) : (
                          <NoneValue />
                        )}
                      </span>
                      <span
                        className={cn(
                          "w-14 text-end text-[10px] tracking-wide uppercase",
                          role === "wins" && "font-semibold text-primary",
                        )}
                      >
                        {roleLabel[role]}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
    </div>
  );
}

function SourceLink({
  source,
}: {
  source: FieldResolution["sourceEntity"] | undefined;
}) {
  return source ? (
    <ExplanationEntityLink
      entity={source.entityKind}
      id={source.entityId}
      name={source.name}
    />
  ) : null;
}

/** The dense facts behind the headline: what an override replaces, where an
 * inherited value comes from, what is stored under an allocation. */
function resolutionStats(
  entity: Entity,
  field: string,
  resolution: FieldResolution,
  evidence: Evidence | null | undefined,
): Array<{ label: string; content: ReactNode }> {
  const value = (raw: ExplanationValue) => (
    <ResolutionValue entity={entity} field={field} value={raw} />
  );
  switch (resolution.mode) {
    case "explicit":
    case "none":
      return resolution.fallbackValue === null
        ? []
        : [
            {
              label: "Fallback",
              content: (
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                  {value(resolution.fallbackValue)}
                  {evidence?.fallbackSource ? (
                    <>
                      <span className="text-muted-foreground">from</span>
                      <SourceLink source={evidence.fallbackSource} />
                    </>
                  ) : null}
                </span>
              ),
            },
          ];
    case "inherit":
      return [
        {
          label: "From",
          content: (
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
              {/* Some resolvers name the source record itself as the source. */}
              {resolution.source === resolution.sourceEntity?.name ? null : (
                <span>{capitalize(resolution.source)}</span>
              )}
              <SourceLink source={resolution.sourceEntity} />
            </span>
          ),
        },
      ];
    case "allocated":
      return [
        ...(resolution.sourceEntity
          ? [
              {
                label: "From",
                content: <SourceLink source={resolution.sourceEntity} />,
              },
            ]
          : []),
        ...(resolution.storedValue !== null
          ? [{ label: "Stored", content: value(resolution.storedValue) }]
          : []),
      ];
  }
}

export const sectionLabelClassName =
  "text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

/** The structured, per-field-resolution replacement for the generic
 * "Current value" block: what wins, the facts behind it, and the inheritance
 * ladder. Purely a rendering of the server's typed `FieldResolution`; it never
 * recomputes precedence. */
export function ResolutionExplanation({
  entity,
  id,
  field,
  resolution,
  evidence,
}: {
  entity: Entity;
  id?: string;
  field: string;
  resolution: FieldResolution;
  evidence?: FieldExplanationOutput["resolutionEvidence"];
}) {
  const stats = resolutionStats(entity, field, resolution, evidence);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <ResolutionHeadline
        entity={entity}
        field={field}
        resolution={resolution}
      />
      {stats.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {stats.map((stat) => (
            <div key={stat.label} className="contents">
              <dt className="text-muted-foreground">{stat.label}</dt>
              <dd className="min-w-0">{stat.content}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {/* A ladder of just the subject repeats the headline. */}
      {evidence &&
      evidence.hierarchy.some((source) => source.entity?.entityId !== id) ? (
        <section className="grid gap-1.5">
          <h3 className={sectionLabelClassName}>Resolution order</h3>
          <ResolutionLadder
            entity={entity}
            field={field}
            id={id}
            resolution={resolution}
            hierarchy={evidence.hierarchy}
          />
        </section>
      ) : null}
    </div>
  );
}
