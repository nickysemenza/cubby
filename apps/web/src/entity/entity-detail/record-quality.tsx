import {
  dataCheck,
  dataCheckPresentation,
  scoredEntities,
} from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useId, type ReactNode } from "react";

import { ExceptionControls } from "~/entity/field-explanation-exception";
import { fieldExplanation } from "~/integrations/tanstack-query/generated/catalog.gen";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/useHydrated";
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
  const checks = (breakdown?.checks ?? EMPTY_CHECKS).filter((check) => {
    const placement = placementOf(check);
    if (placement && "field" in placement && visibleFields)
      return visibleFields.includes(placement.field);
    if (placement && "section" in placement && visibleSections)
      return visibleSections.includes(placement.section);
    return true;
  });
  const orphaned = checks.filter((check) => {
    const placement = placementOf(check);
    return (
      !placement ||
      ("section" in placement &&
        renderedSections &&
        !renderedSections.includes(placement.section))
    );
  });
  const attention = checks.filter((check) => check.state === "gap");
  const anchor = (check: RecordQualityCheck) => {
    const placement = placementOf(check);
    return placement && "field" in placement
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
                {checks.filter((check) => check.state === "satisfied").length}{" "}
                satisfied · {attention.length} unresolved ·{" "}
                {checks.filter((check) => check.state === "excepted").length}{" "}
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
