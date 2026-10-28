import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";

import { RecordsBlockView } from "~/entity/entity-detail/records-block";
import { useEntityMetadata } from "~/entity/metadata";
import { Disclosure } from "~/ui/layout/disclosure";

import { SourceStack } from "./source-stack";
import {
  ExplanationEntityLink,
  WhyValue,
  ReadableExplanationValue,
} from "./why-value";

type Evidence = NonNullable<FieldExplanationOutput["resolutionEvidence"]>;
export const sectionLabelClassName =
  "text-xs font-semibold text-muted-foreground";
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
      <h3 className={sectionLabelClassName}>Current source evidence</h3>
      <ResolutionChain
        block={{ ...evidence.chain, title: undefined }}
        steps={evidence.steps}
      />
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
            <Disclosure
              summary={`Show ${contributors.length - 6} more contributors`}
            >
              {contributors.slice(6).map((block) => (
                <Contributor
                  key={block.chain.key ?? JSON.stringify(block.chain)}
                  block={block}
                />
              ))}
            </Disclosure>
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
    <Disclosure
      summary={
        <>
          {block.title ?? "Contributor"}
          {block.rows[0]?.trailing ? (
            <span className="ml-2 text-muted-foreground">
              {block.rows[0].trailing}
            </span>
          ) : null}
        </>
      }
      className="border-t border-border pt-2"
    >
      <ResolutionChain
        block={{ ...block, title: undefined }}
        steps={contributor.steps}
      />
      <FieldEvaluationInputs
        evidence={{
          chain: block,
          steps: contributor.steps,
          coverage: contributor.coverage,
          fallbackSource: null,
        }}
      />
    </Disclosure>
  );
}

function ResolutionChain({
  block,
  steps,
}: {
  block: Chain;
  steps?: Evidence["steps"];
}) {
  return (
    <>
      {block.rows.length === 0 ? (
        <RecordsBlockView block={{ ...block, footer: undefined }} />
      ) : (
        <SourceStack
          label={block.title ?? "Resolution order"}
          rows={block.rows.map((row, index) => {
            const step = steps?.find(
              (candidate) => candidate.rowIndex === index,
            );
            return {
              key: `${index}:${row.title}`,
              status:
                step?.effect === "blocked"
                  ? "blocked"
                  : step?.effect === "used" || step?.effect === "fallback"
                    ? "deciding"
                    : "skipped",
              // The report row owns its linked title and all supporting values.
              title: null,
              children: (
                <RecordsBlockView
                  block={{
                    ...block,
                    title: undefined,
                    footer: undefined,
                    rows: [row],
                  }}
                />
              ),
            };
          })}
        />
      )}
      {block.footer ? (
        <p className="text-xs text-muted-foreground">{block.footer}</p>
      ) : null}
    </>
  );
}

/** Render the resolver's trace verbatim; an unresolved winner still blocks later sources. */
function FieldEvaluationInputs({ evidence }: { evidence: Evidence }) {
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
        <Disclosure summary="Inputs and source settings">
          <div className="grid gap-3">
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
                    {observation.entity && observation.fields ? (
                      <ObservedFieldLinks
                        target={observation.entity}
                        fields={observation.fields}
                      />
                    ) : null}
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
        </Disclosure>
      ) : null}
    </div>
  );
}

function ObservedFieldLinks({
  target,
  fields,
}: {
  target: NonNullable<
    NonNullable<Evidence["steps"]>[number]["observed"][number]["entity"]
  >;
  fields: readonly string[];
}) {
  const metadata = useEntityMetadata(target.entityKind);
  return fields.map((key) => {
    const field = metadata.fields.fields.find(
      (candidate) => candidate.key === key,
    );
    return field?.explanation ? (
      <span key={key} className="inline-flex items-center gap-1">
        <span>{field.label}</span>
        <WhyValue
          entity={target.entityKind}
          id={target.entityId}
          field={key}
          label={field.label}
        />
      </span>
    ) : null;
  });
}
