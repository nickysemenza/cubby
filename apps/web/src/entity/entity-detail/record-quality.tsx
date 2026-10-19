import {
  dataCheck,
  dataCheckPresentation,
  scoredEntities,
} from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { countLabel } from "@cubby/shared/pluralize";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createContext, useContext, useId, type ReactNode } from "react";

import { ExceptionControls } from "~/entity/fields/field-explanation-exception";
import {
  fieldExplanation,
  suggestions,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Stack, SectionHeading } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

type Breakdown = NonNullable<FieldExplanationOutput["qualityBreakdown"]>;
export type RecordQualityCheck = Breakdown["checks"][number];
const EMPTY_CHECKS: readonly RecordQualityCheck[] = [];
const QualityContext = createContext<{
  entity: Entity;
  id: string;
  prefix: string;
  checks: readonly RecordQualityCheck[];
} | null>(null);
const scored = new Set<Entity>(scoredEntities);

const placementOf = (check: RecordQualityCheck) => {
  const parsed = dataCheck.safeParse(check.check);
  return parsed.success ? dataCheckPresentation[parsed.data].placement : null;
};

export function QualityResult({ check }: { check: RecordQualityCheck }) {
  const Icon =
    check.state === "satisfied"
      ? CheckIcon
      : check.state === "excepted"
        ? MinusCircleIcon
        : WarningCircleIcon;
  const tone =
    check.state === "satisfied"
      ? "text-positive"
      : check.state === "excepted"
        ? "text-muted-foreground"
        : check.kind === "defect"
          ? "text-destructive"
          : "text-warning-ink";
  return (
    <span
      className={`inline-flex min-w-0 items-start gap-1 text-xs ${tone}`}
      title={check.stateLabel}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {check.label}
        {check.state === "excepted"
          ? " · Accepted exception"
          : check.state === "gap"
            ? ` · ${check.stateLabel}`
            : null}
        <span className="sr-only"> · {check.stateLabel}</span>
      </span>
    </span>
  );
}

export function QualityCheckDetails({
  check,
  entityId,
}: {
  check: RecordQualityCheck;
  entityId: string;
}) {
  return (
    <Stack gap="xs">
      <QualityResult check={check} />
      {check.state === "gap" ? (
        <p className="text-xs">{check.description}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{check.weightLabel}</p>
      <ExceptionControls entityId={entityId} check={check} />
    </Stack>
  );
}

export function useFieldQuality(entity: Entity, id: string | undefined) {
  const context = useContext(QualityContext);
  return context?.entity === entity && context.id === id ? context : null;
}

export function fieldQualityChecks(
  checks: readonly RecordQualityCheck[],
  field: string,
) {
  return checks.filter((check) => {
    const placement = placementOf(check);
    return placement && "field" in placement && placement.field === field;
  });
}

function QualityCheckRows({
  checks,
}: {
  checks: readonly RecordQualityCheck[];
}) {
  const context = useContext(QualityContext);
  if (!context || checks.length === 0) return null;
  return (
    <Ledger>
      {checks.map((check) => (
        <LedgerRow key={check.check} id={`${context.prefix}-${check.check}`}>
          <LedgerCell slot="group">
            <details>
              <summary className="flex cursor-pointer items-center justify-between gap-2">
                <QualityResult check={check} />
                <span className="shrink-0 text-xs text-muted-foreground">
                  Explain
                </span>
              </summary>
              <div className="py-2">
                <QualityCheckDetails check={check} entityId={context.id} />
              </div>
            </details>
          </LedgerCell>
        </LedgerRow>
      ))}
    </Ledger>
  );
}

/** Section checks appear once, beside the evidence the section owns. */
export function QualitySectionChecks({ section }: { section: string }) {
  const context = useContext(QualityContext);
  const checks =
    context?.checks.filter((check) => {
      const placement = placementOf(check);
      return (
        placement && "section" in placement && placement.section === section
      );
    }) ?? EMPTY_CHECKS;
  return <QualityCheckRows checks={checks} />;
}

/** Sections the record's evaluated checks place, in check order. */
export function useQualityCheckSections() {
  const context = useContext(QualityContext);
  return [
    ...new Set(
      (context?.checks ?? EMPTY_CHECKS).flatMap((check) => {
        const placement = placementOf(check);
        return placement && "section" in placement ? [placement.section] : [];
      }),
    ),
  ];
}

/** Enough rows to cover one record's pending Suggestions, impact first. */
const IMPACT_READ_LIMIT = 100;

/**
 * "N Suggestions would fix this": pending Suggestions on the record that
 * declare an impact on one of its unresolved checks, linked to the
 * Suggestions page scoped to the record.
 */
function SuggestionsImpactLink({
  entity,
  id,
  failing,
}: {
  entity: Entity;
  id: string;
  failing: readonly RecordQualityCheck[];
}) {
  const kind = shortcodeEntities.find((candidate) => candidate === entity);
  const checks = new Set(failing.map((check) => check.check));
  const list = useQuery({
    ...suggestions.list.queryOptions({
      entity: kind,
      recordIds: [id],
      order: [{ by: "impact", direction: "desc" }],
      limit: IMPACT_READ_LIMIT,
    }),
    enabled: kind !== undefined && checks.size > 0,
  });
  const fixing =
    list.data?.items.filter((row) =>
      row.impact.some(
        (impact) =>
          impact.kind === "quality_check" &&
          impact.qualityCheck !== undefined &&
          checks.has(impact.qualityCheck),
      ),
    ).length ?? 0;
  if (!kind || fixing === 0) return null;
  return (
    <Link
      to="/suggestions"
      search={{ record: `${kind}:${id}` }}
      className="text-primary underline-offset-2 hover:underline"
    >
      {countLabel(fixing, "Suggestion")} would fix this
    </Link>
  );
}

type RecordQualityProps = {
  entity: Entity;
  id: string;
  children: ReactNode;
  visibleFields?: readonly string[];
  visibleSections?: readonly string[];
  renderedSections?: readonly string[];
};

function AssessedRecordQuality({
  entity,
  id,
  children,
  visibleFields,
  visibleSections,
  renderedSections,
}: RecordQualityProps) {
  const prefix = useId();
  const hydrated = useHydrated();
  const result = useQuery({
    ...fieldExplanation.explain.queryOptions({
      entityKind: entity,
      entityId: id,
      field: "dataQuality",
      surface: "detail",
    }),
    enabled: hydrated,
  });
  const breakdown = result.data?.qualityBreakdown;
  // The score covers every check, so the counts and issue links do too; a
  // check this surface does not place falls to the Record quality list.
  const allChecks = breakdown?.checks ?? EMPTY_CHECKS;
  const placed = (check: RecordQualityCheck) => {
    const placement = placementOf(check);
    if (!placement) return false;
    if ("field" in placement)
      return !visibleFields || visibleFields.includes(placement.field);
    return (
      (!visibleSections || visibleSections.includes(placement.section)) &&
      (!renderedSections || renderedSections.includes(placement.section))
    );
  };
  const checks = allChecks.filter(placed);
  const orphaned = allChecks.filter((check) => !placed(check));
  const attention = allChecks.filter((check) => check.state === "gap");
  const anchor = (check: RecordQualityCheck) => {
    const placement = placementOf(check);
    return placement && "field" in placement && placed(check)
      ? `${prefix}-field-${placement.field}`
      : `${prefix}-${check.check}`;
  };
  return (
    <QualityContext value={{ entity, id, prefix, checks }}>
      <Stack gap="sm">
        {result.isPending ? (
          <output className="text-xs text-muted-foreground">
            Loading quality checks…
          </output>
        ) : result.isError ? (
          <div>
            <ErrorDisplay error={result.error} title="quality checks" />
            <Button
              size="xs"
              variant="outline"
              onClick={() => void result.refetch()}
            >
              Retry quality checks
            </Button>
          </div>
        ) : breakdown ? (
          <div className="border-b border-border pb-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong>
                Quality{" "}
                {breakdown.score === null
                  ? "not assessed"
                  : `${breakdown.score}/100`}
              </strong>
              <span className="text-muted-foreground">
                {
                  allChecks.filter((check) => check.state === "satisfied")
                    .length
                }{" "}
                satisfied · {attention.length} unresolved ·{" "}
                {allChecks.filter((check) => check.state === "excepted").length}{" "}
                accepted exceptions
              </span>
            </div>
            {attention.length > 0 ? (
              <nav
                aria-label="Quality issues"
                className="mt-1 flex flex-wrap gap-x-3 gap-y-1"
              >
                {attention.map((check) => (
                  <a
                    key={check.check}
                    href={`#${anchor(check)}`}
                    className="text-warning-ink underline-offset-2 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      const target = document.getElementById(anchor(check));
                      target?.scrollIntoView({ block: "center" });
                      if (target) {
                        target.tabIndex = -1;
                        target.focus({ preventScroll: true });
                      }
                    }}
                  >
                    {check.label}
                  </a>
                ))}
              </nav>
            ) : null}
            {attention.length > 0 ? (
              <div className="mt-1">
                <SuggestionsImpactLink
                  entity={entity}
                  id={id}
                  failing={attention}
                />
              </div>
            ) : null}
            <details className="mt-1">
              <summary className="cursor-pointer text-muted-foreground">
                Score calculation
              </summary>
              <p className="pt-2">{breakdown.summary}</p>
            </details>
          </div>
        ) : null}
        {orphaned.length > 0 ? (
          <section>
            <SectionHeading title="Record quality" />
            <QualityCheckRows checks={orphaned} />
          </section>
        ) : null}
        {children}
      </Stack>
    </QualityContext>
  );
}

export function RecordQualityProvider(props: RecordQualityProps) {
  return scored.has(props.entity) ? (
    <AssessedRecordQuality key={`${props.entity}:${props.id}`} {...props} />
  ) : (
    <>{props.children}</>
  );
}
