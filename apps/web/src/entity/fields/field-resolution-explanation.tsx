import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import { capitalize, parseShortcode } from "@cubby/shared";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { enumFieldLabel } from "~/entity/display/enum-field-display";
import { RecordsBlockView } from "~/entity/entity-detail/records-block";
import { Badge, type BadgeVariant } from "~/ui/primitives/badge";
import { NoneValue } from "~/ui/primitives/none-value";

import {
  ExplanationEntityLink,
  FieldExplanation,
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
          {
            mixed: "Mixed",
            unset: policy?.labels?.unresolved ?? "Not set",
            blocked: "Blocked",
          }[evidence.outcome]
        ) : resolution.value === null &&
          resolution.mode === "allocated" &&
          evidence?.outcome === "resolved" ? (
          "Allocated"
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
      <FieldEvaluationInputs evidence={evidence} />
      {contributors.length > 0 ? (
        <>
          {evidence.chain.rows.length > 0 || evidence.chain.empty ? (
            <h4 className={sectionLabelClassName}>Contributing records</h4>
          ) : null}
          {contributors.slice(0, 6).map((block) => (
            <Contributor
              key={block.chain.key ?? JSON.stringify(block.chain)}
              block={block}
            />
          ))}
          {contributors.length > 6 ? (
            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-xs font-medium md:min-h-0">
                Show {contributors.length - 6} more contributors
              </summary>
              {contributors.slice(6).map((block) => (
                <Contributor
                  key={block.chain.key ?? JSON.stringify(block.chain)}
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

function Contributor({
  block: contributor,
}: {
  block: NonNullable<Evidence["contributors"]>[number];
}) {
  const block = contributor.chain;
  return (
    <details className="min-w-0 border-t border-border pt-2">
      <summary className="min-h-11 cursor-pointer py-2 text-xs font-medium break-words md:min-h-0">
        {block.title ?? "Contributor"}
        {block.rows[0]?.trailing ? (
          <span className="ml-2 text-muted-foreground">
            {block.rows[0].trailing}
          </span>
        ) : null}
      </summary>
      <ResolutionChain block={{ ...block, title: undefined }} />
      <FieldEvaluationInputs
        evidence={{
          chain: block,
          steps: contributor.steps,
          coverage: contributor.coverage,
          fallbackSource: null,
        }}
      />
    </details>
  );
}

function ResolutionChain({ block }: { block: Chain }) {
  return (
    <>
      <RecordsBlockView block={{ ...block, rows: block.rows.slice(0, 6) }} />
      {block.rows.length > 6 ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-xs font-medium md:min-h-0">
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

/** Render the resolver's trace verbatim; an unresolved winner still blocks later sources. */
function FieldEvaluationInputs({ evidence }: { evidence: Evidence }) {
  const [inputsOpen, setInputsOpen] = useState(false);
  return (
    <div className="grid min-w-0 gap-2">
      {evidence.coverage && evidence.coverage.omitted > 0 ? (
        <p className="text-xs text-muted-foreground">
          Showing {evidence.coverage.shown} of {evidence.coverage.total}{" "}
          evaluation rows.
        </p>
      ) : null}
      {evidence.branches && evidence.branches.omitted > 0 ? (
        <p className="text-xs text-muted-foreground">
          Showing {evidence.branches.shown} of {evidence.branches.total}{" "}
          inventory entries.
        </p>
      ) : null}
      {evidence.steps?.some((step) => step.observed.length > 0) ? (
        <details onToggle={(event) => setInputsOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-xs font-medium">
            Inputs and source settings
          </summary>
          {inputsOpen ? (
            <div className="grid gap-3 pt-2">
              {evidence.steps.map((step) => (
                <div
                  key={`${step.branch?.entityId ?? "subject"}:${step.source}:${step.rowIndex}`}
                  className="grid min-w-0 gap-1"
                >
                  <p className="text-xs font-semibold">
                    {evidence.chain.rows[step.rowIndex]?.title ?? step.source}
                  </p>
                  {step.observed.map((observation) => (
                    <div
                      key={`${observation.label}:${observation.entity?.entityId ?? "self"}:${JSON.stringify(observation.value)}`}
                      className="grid min-w-0 gap-1 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-1">
                        <span>{observation.label}</span>
                        {observation.entity ? (
                          <ExplanationEntityLink
                            entity={observation.entity.entityKind}
                            id={observation.entity.entityId}
                          />
                        ) : null}
                      </div>
                      {observation.entity
                        ? observation.fields?.map((key) => {
                            const target = observation.entity!;
                            const sourceField = entityFieldModels[
                              target.entityKind
                            ].fields.find((candidate) => candidate.key === key);
                            return sourceField?.explanation ? (
                              <span
                                key={key}
                                className="inline-flex items-center gap-1"
                              >
                                <span>{sourceField.label}</span>
                                <FieldExplanation
                                  entity={target.entityKind}
                                  id={target.entityId}
                                  field={key}
                                  label={sourceField.label}
                                />
                              </span>
                            ) : null;
                          })
                        : null}
                      <ReadableExplanationValue value={observation.value} />
                    </div>
                  ))}
                  {step.coverage && step.coverage.omitted > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Showing {step.coverage.shown} of {step.coverage.total}{" "}
                      inputs.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
