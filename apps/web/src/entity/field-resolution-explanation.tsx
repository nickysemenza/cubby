import type { Entity } from "@cubby/schemas/entity";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { capitalize, parseShortcode } from "@cubby/shared";
import type { ReactNode } from "react";
import { z } from "zod";

import { RecordsBlockView } from "~/entity/entity-detail/records-block";
import { enumFieldLabel } from "~/entity/enum-field-display";
import { Badge, type BadgeVariant } from "~/ui/primitives/badge";
import { NoneValue } from "~/ui/primitives/none-value";

import {
  ExplanationEntityLink,
  ReadableExplanationValue,
  type ExplanationValue,
} from "./field-explanation";
import {
  resolutionPolicyFor,
  resolutionState,
  type ResolutionTone,
} from "./field-resolution";

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

export function ResolutionHeadline({
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
  const policy = resolutionPolicyFor(entity, field);
  const { tone, label, Icon } = resolutionState(resolution, {
    intentional: policy?.redundancy === "intentional",
  });
  const emptyLabel =
    resolution.mode === "inherit"
      ? policy?.labels?.unresolved
      : policy?.labels?.none;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <span className="min-w-0 text-base leading-snug font-semibold break-words">
        {evidence?.outcome && evidence.outcome !== "resolved" ? (
          { mixed: "Mixed", unset: "Not set", blocked: "Blocked" }[
            evidence.outcome
          ]
        ) : resolution.value === null && emptyLabel ? (
          emptyLabel
        ) : (
          <ResolutionValue
            entity={entity}
            field={field}
            value={resolution.value}
          />
        )}
      </span>
      <Badge variant={toneBadge[tone]}>
        <Icon aria-hidden="true" />
        {label}
      </Badge>
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
  "text-xs font-medium text-muted-foreground";

/** The structured, per-field-resolution replacement for the generic
 * "Current value" block: what wins, the facts behind it, and the inheritance
 * ladder. Purely a rendering of the server's typed `FieldResolution`; it never
 * recomputes precedence. */
export function ResolutionExplanation({
  entity,
  field,
  resolution,
  evidence,
  showHeadline = true,
}: {
  entity: Entity;
  field: string;
  resolution: FieldResolution;
  evidence?: FieldExplanationOutput["resolutionEvidence"];
  showHeadline?: boolean;
}) {
  const stats = resolutionStats(entity, field, resolution, evidence);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      {showHeadline ? (
        <ResolutionHeadline
          entity={entity}
          field={field}
          resolution={resolution}
          evidence={evidence}
        />
      ) : null}
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
      <ResolutionEvidence evidence={evidence} />
    </div>
  );
}

/** A link is optional evidence, never the condition for showing a decision. */
export function ResolutionEvidence({
  evidence,
}: {
  evidence?: FieldExplanationOutput["resolutionEvidence"];
}) {
  if (!evidence) return null;
  const contributors = evidence.contributors ?? [];
  return (
    <section className="grid min-w-0 gap-2 border-t border-border pt-3">
      <h3 className={sectionLabelClassName}>
        {evidence.chain.title ?? "Resolution order"}
      </h3>
      <ResolutionChain block={{ ...evidence.chain, title: undefined }} />
      {contributors.length > 0 ? (
        <>
          {evidence.chain.rows.length > 0 || evidence.chain.empty ? (
            <h4 className={sectionLabelClassName}>Contributing records</h4>
          ) : null}
          {contributors.slice(0, 6).map((block) => (
            <Contributor
              key={block.key ?? JSON.stringify(block)}
              block={block}
            />
          ))}
          {contributors.length > 6 ? (
            <details>
              <summary className="cursor-pointer py-2 text-xs font-medium">
                Show {contributors.length - 6} more contributors
              </summary>
              {contributors.slice(6).map((block) => (
                <Contributor
                  key={block.key ?? JSON.stringify(block)}
                  block={block}
                />
              ))}
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

type Chain = Evidence["chain"];

function Contributor({ block }: { block: Chain }) {
  return (
    <details className="min-w-0 border-t border-border pt-2">
      <summary className="cursor-pointer py-2 text-xs font-medium break-words">
        {block.title ?? "Contributor"}
        {block.rows[0]?.trailing ? (
          <span className="ml-2 text-muted-foreground">
            {block.rows[0].trailing}
          </span>
        ) : null}
      </summary>
      <ResolutionChain block={{ ...block, title: undefined }} />
    </details>
  );
}

function ResolutionChain({ block }: { block: Chain }) {
  return (
    <>
      <RecordsBlockView block={{ ...block, rows: block.rows.slice(0, 6) }} />
      {block.rows.length > 6 ? (
        <details>
          <summary className="cursor-pointer py-2 text-xs font-medium">
            Show {block.rows.length - 6} more resolution steps
          </summary>
          <RecordsBlockView
            block={{
              ...block,
              title: undefined,
              footer: undefined,
              rows: block.rows.slice(6),
            }}
          />
        </details>
      ) : null}
    </>
  );
}
