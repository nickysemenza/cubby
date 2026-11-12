import {
  dataCheck,
  dataCheckPresentation,
  scoredEntities,
} from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-roster";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { countLabel } from "@cubby/shared/pluralize";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useId, type ReactNode } from "react";

import { WhyValue } from "~/entity/fields/explanation/why-value";
import { recordSuggestionScope } from "~/entity/suggestions/queue/record-scope";
import { fieldExplanation } from "~/integrations/tanstack-query/generated/domains/fieldExplanation.gen";
import { suggestions } from "~/integrations/tanstack-query/generated/domains/suggestions.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Section, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/records/ledger";

type Breakdown = NonNullable<FieldExplanationOutput["qualityBreakdown"]>;
export type RecordQualityCheck = Breakdown["checks"][number];
const EMPTY_CHECKS: readonly RecordQualityCheck[] = [];
const QualityContext = createContext<{
  entity: Entity;
  id: string;
  prefix: string;
  checks: readonly RecordQualityCheck[];
  resolution?: FieldExplanationOutput["envelope"];
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
  // A satisfied check stays visible without asking for attention; a diagnostic
  // gap reads no louder.
  const tone =
    check.state !== "gap" || (check.kind === "missing" && check.weight === 0)
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
  // Satisfied checks stay visible, as one quiet line; open ones keep a row.
  const open = checks.filter((check) => check.state !== "satisfied");
  const satisfied = checks.filter((check) => check.state === "satisfied");
  return (
    <div className="min-w-0">
      {open.length > 0 ? (
        <Ledger>
          {open.map((check) => (
            <LedgerRow
              key={check.check}
              id={`${context.prefix}-${check.check}`}
            >
              <LedgerCell slot="group">
                <div className="flex items-center justify-between gap-2">
                  <QualityResult check={check} />
                  <WhyValue
                    entity={context.entity}
                    id={context.id}
                    field="dataQuality"
                    label={check.label}
                    resolution={context.resolution}
                  />
                </div>
              </LedgerCell>
            </LedgerRow>
          ))}
        </Ledger>
      ) : null}
      {satisfied.length > 0 ? (
        <p className="flex flex-wrap gap-x-3 text-xs/4.5 text-muted-foreground">
          {satisfied.map((check) => (
            <span
              key={check.check}
              id={`${context.prefix}-${check.check}`}
              className="inline-flex items-center gap-1"
            >
              <CheckIcon aria-hidden className="size-3 shrink-0" />
              {check.label}
              <span className="sr-only"> · {check.stateLabel}</span>
            </span>
          ))}
        </p>
      ) : null}
    </div>
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
      ...recordSuggestionScope(id),
      sort: [{ orderBy: "impact", direction: "desc" }],
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
  /**
   * `inline` draws the summary and unplaced checks above the children (the
   * inspector); `placed` leaves them to `RecordQualitySection` and
   * `useQualityAttention`, which the full page puts in a tab and Needs you.
   */
  summary?: "inline" | "placed";
};

/** What the record's quality read says, for the summary and Needs you. */
interface QualityAssessment {
  query: ReturnType<typeof useFieldExplanation>;
  checks: readonly RecordQualityCheck[];
  orphaned: readonly RecordQualityCheck[];
  unresolved: readonly RecordQualityCheck[];
  attention: readonly RecordQualityCheck[];
  anchor: (check: RecordQualityCheck) => string;
}

const AssessmentContext = createContext<QualityAssessment | null>(null);

function useFieldExplanation(entity: Entity, id: string) {
  const hydrated = useHydrated();
  return useQuery({
    ...fieldExplanation.explain.queryOptions({
      entityKind: entity,
      entityId: id,
      field: "dataQuality",
      surface: "detail",
    }),
    enabled: hydrated,
  });
}

/** Opens the check's anchor: its field or result row, selecting its tab first. */
export function QualityIssueLink({
  check,
  anchor,
  className,
}: {
  check: RecordQualityCheck;
  anchor: string;
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <a
      href={`#${anchor}`}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        void navigate({
          to: ".",
          search: true,
          hash: anchor,
          resetScroll: false,
          hashScrollIntoView: false,
        });
      }}
    >
      {check.label}
    </a>
  );
}

/**
 * The record's quality summary: counts, how it is assessed, the open issues,
 * the Suggestions that would fix them and the results no section places.
 */
function QualitySummary({
  entity,
  id,
  titledOrphans = false,
}: {
  entity: Entity;
  id: string;
  /** Head the unplaced results "Record quality" (the inspector has no tab). */
  titledOrphans?: boolean;
}) {
  const assessment = useContext(AssessmentContext);
  if (!assessment) return null;
  const { query, orphaned, unresolved, attention, anchor } = assessment;
  const breakdown = query.data?.qualityBreakdown;
  const allChecks = breakdown?.checks ?? EMPTY_CHECKS;
  return (
    <>
      {query.isPending ? (
        <output className="text-xs text-muted-foreground">
          Loading quality checks…
        </output>
      ) : query.isError ? (
        <div>
          <ErrorDisplay error={query.error} title="quality checks" />
          <Button
            size="xs"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry quality checks
          </Button>
        </div>
      ) : breakdown ? (
        <div className="border-b border-border pb-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <strong>
              {breakdown.status === "not_assessed"
                ? "Quality not assessed"
                : unresolved.length === 0
                  ? "Nothing missing"
                  : `${unresolved.length} missing`}
            </strong>
            <span className="text-muted-foreground">
              {allChecks.filter((check) => check.state === "satisfied").length}{" "}
              satisfied · {unresolved.length} unresolved ·{" "}
              {allChecks.filter((check) => check.state === "excepted").length}{" "}
              accepted exceptions
            </span>
            <WhyValue
              entity={entity}
              id={id}
              field="dataQuality"
              label="Quality checks"
              resolution={query.data?.envelope}
            />
          </div>
          {attention.length > 0 ? (
            <nav
              aria-label="Quality issues"
              className="mt-1 flex flex-wrap gap-x-3 gap-y-1"
            >
              {attention.map((check) => (
                <QualityIssueLink
                  key={check.check}
                  check={check}
                  anchor={anchor(check)}
                  className="text-warning-ink underline-offset-2 hover:underline"
                />
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
        </div>
      ) : null}
      {orphaned.length === 0 ? null : titledOrphans ? (
        <Section title="Record quality" headingAs="h2">
          <QualityCheckRows checks={orphaned} />
        </Section>
      ) : (
        <QualityCheckRows checks={orphaned} />
      )}
    </>
  );
}

/** The full page's Record quality section body. */
export function RecordQualitySection({
  entity,
  id,
}: {
  entity: Entity;
  id: string;
}) {
  return (
    <div className="grid min-w-0 gap-2">
      <QualitySummary entity={entity} id={id} />
    </div>
  );
}

/**
 * The open checks that ask a member for something, each linked to its field
 * or result: the full page lists them under Needs you.
 */
export function useQualityAttention() {
  const assessment = useContext(AssessmentContext);
  return (assessment?.attention ?? EMPTY_CHECKS).map((check) => ({
    check,
    anchor: assessment?.anchor(check) ?? "",
  }));
}

function AssessedRecordQuality({
  entity,
  id,
  children,
  visibleFields,
  visibleSections,
  renderedSections,
  summary = "inline",
}: RecordQualityProps) {
  const prefix = useId();
  const result = useFieldExplanation(entity, id);
  const breakdown = result.data?.qualityBreakdown;
  // The summary covers every check, so the counts and issue links do too; a
  // check this surface does not place keeps its result in a fallback list.
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
  // An unscored check only caps a record just short of 100, so it stays
  // beside its evidence rather than asking the member for anything here.
  const unresolved = allChecks.filter((check) => check.state === "gap");
  const attention = unresolved.filter(
    (check) => check.weight > 0 || check.kind === "defect",
  );
  const anchor = (check: RecordQualityCheck) => {
    const placement = placementOf(check);
    return placement && "field" in placement && placed(check)
      ? `${prefix}-field-${placement.field}`
      : `${prefix}-${check.check}`;
  };
  return (
    <QualityContext
      value={{ entity, id, prefix, checks, resolution: result.data?.envelope }}
    >
      <AssessmentContext
        value={{
          query: result,
          checks,
          orphaned,
          unresolved,
          attention,
          anchor,
        }}
      >
        {summary === "inline" ? (
          <Stack gap="sm">
            <QualitySummary entity={entity} id={id} titledOrphans />
            {children}
          </Stack>
        ) : (
          children
        )}
      </AssessmentContext>
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

/** Whether the entity's records carry quality checks at all. */
export const isScoredEntity = (entity: Entity) => scored.has(entity);
