import type { AssessmentFamily } from "@cubby/schemas/assessment";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { ReportBlocks } from "~/entity/entity-detail/report-slot";
import { entityListHref } from "~/entity/entity-list-href";
import { job } from "~/integrations/tanstack-query/generated/catalog/job.gen";
import { runDetail } from "~/integrations/tanstack-query/generated/catalog/runDetail.gen";
import { formatCount } from "~/lib/number-format";
import { runPlanBlocks } from "~/lib/run-plan";
import { Picker } from "~/ui/combobox/picker";
import type { KeyNumber } from "~/ui/common/key-numbers";
import { RecordList } from "~/ui/common/record-list";
import {
  useSectionCount,
  useSectionEmpty,
} from "~/ui/data-table/detail-section-state";
import { Button } from "~/ui/primitives/button";

import { JobDiagnostics } from "../job/job-diagnostics";
import { DecisionLedger } from "./decision-ledger";
import { decisionFacetCounts, presenterFor } from "./decision-presenters";
import { RunStepStrip } from "./run-step-strip";
import {
  type BreakdownGroup,
  ReasonBreakdown,
  RunStepTimeline,
} from "./run-step-timeline";
import { humanizeKey, runOverview, type RunStepView } from "./run-view-model";

const LIVE_POLL_MS = 3_000;
// The declared Run slot ids, which the detail page uses as section ids.
const DIAGNOSTICS_ID = "diagnostics";
const DECISIONS_ID = "decisions";

const live = (status: string) =>
  ACTIVE_RUN_STATUSES.some((active) => active === status);

/**
 * The ledger facet a step tally drilled into. The Steps and Decisions slots
 * are separate sections of one page, so the selection lives beside them,
 * keyed by Run.
 */
const facetByRun = new Map<string, string | null>();
const facetListeners = new Set<() => void>();
const familyByRun = new Map<string, AssessmentFamily>();
function useRunFamily(runId: string) {
  const family = useSyncExternalStore(
    (listener) => {
      facetListeners.add(listener);
      return () => facetListeners.delete(listener);
    },
    () => familyByRun.get(runId) ?? null,
    () => null,
  );
  const setFamily = useCallback(
    (next: AssessmentFamily) => {
      familyByRun.set(runId, next);
      facetByRun.set(runId, null);
      for (const listener of facetListeners) listener();
    },
    [runId],
  );
  return [family, setFamily] as const;
}

function useRunFacet(runId: string) {
  const facet = useSyncExternalStore(
    (listener) => {
      facetListeners.add(listener);
      return () => facetListeners.delete(listener);
    },
    () => facetByRun.get(runId) ?? null,
    () => null,
  );
  const setFacet = useCallback(
    (next: string | null) => {
      facetByRun.set(runId, next);
      for (const listener of facetListeners) listener();
    },
    [runId],
  );
  return [facet, setFacet] as const;
}

const scrollTo = (id: string) =>
  document
    .getElementById(id)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });

/**
 * The reads every Run detail slot shares; React Query dedupes them, so the
 * Steps, Decisions and Diagnostics sections poll once together.
 */
function useRunDetail(record: RunOut) {
  const polling = live(record.status) ? LIVE_POLL_MS : false;
  const [selectedFamily, setFamily] = useRunFamily(record.id);
  const steps = useQuery({
    ...runDetail.steps.queryOptions({ runId: record.id }),
    refetchInterval: polling,
  });
  const jobs = useQuery({
    ...job.list.queryOptions({ runId: record.id }),
    refetchInterval: polling,
  });
  const overview = steps.data
    ? runOverview(steps.data, jobs.data, Date.now(), steps.data.input)
    : null;
  const families = [
    ...new Set(
      overview?.steps.flatMap((step) => (step.results ? [step.results] : [])) ??
        [],
    ),
  ];
  // Start with the latest publication; earlier families remain selectable.
  const family: AssessmentFamily | null =
    selectedFamily && families.includes(selectedFamily)
      ? selectedFamily
      : (overview?.steps
          .filter((step) => step.results && step.phase !== "not_started")
          .at(-1)?.results ??
        overview?.steps.find((step) => step.results)?.results ??
        null);
  const decisions = useQuery({
    ...runDetail.decisions.queryOptions({
      runId: record.id,
      family: family ?? "transfer_pair",
    }),
    enabled: family !== null,
    refetchInterval: polling,
  });
  const presenter = family ? presenterFor(family) : null;
  const rows = decisions.data?.rows ?? [];
  const facets = presenter ? decisionFacetCounts(rows, presenter) : [];
  return {
    steps,
    jobs,
    overview,
    family,
    families,
    setFamily,
    decisions,
    presenter,
    rows,
    facets,
  };
}

/**
 * A step-ledger Run's Steps section: the honest per-step strip and the
 * RunStep timeline. Decisions and Diagnostics are their own declared slots.
 */
export function RunStepsDetail({ record }: { record: RunOut }) {
  const {
    steps,
    overview,
    family,
    setFamily,
    decisions,
    presenter,
    rows,
    facets,
  } = useRunDetail(record);
  const [facet, setFacet] = useRunFacet(record.id);
  useSectionCount(steps.data?.steps.length);

  if (steps.isPending)
    return <RecordList state={{ status: "pending", rows: 4 }} />;
  if (steps.isError || !overview)
    return (
      <RecordList
        state={{
          status: "error",
          error: steps.error,
          title: "Couldn't load steps",
          onRetry: () => void steps.refetch(),
        }}
      />
    );

  const drill = (key: string) => {
    setFacet(key);
    scrollTo(DECISIONS_ID);
  };
  const figures: KeyNumber[] = facets.map((def) => ({
    id: def.key,
    label: def.label.toLowerCase(),
    value: formatCount(def.count),
    active: facet === def.key,
    onSelect: () => drill(def.key),
  }));
  const breakdownOf = (step: RunStepView) => {
    const groups: BreakdownGroup[] = [
      {
        id: "upstream",
        title: "Upstream",
        note: "page counts stored on the step",
        rows: step.reasons.length
          ? [
              {
                id: "processed",
                label: `${humanizeKey(step.unit)} processed`,
                count: step.processed,
                depth: 0,
              },
              ...step.reasons.map((reason) => ({
                id: reason.code,
                label: humanizeKey(reason.code),
                count: reason.count,
                depth: 1 as const,
                code: reason.code,
              })),
            ]
          : [],
      },
    ];
    if (presenter && step.results === family && rows.length)
      groups.push({
        id: "candidates",
        title: "Per result",
        note: `${formatCount(decisions.data?.total ?? rows.length)} Assessments published`,
        rows: [
          {
            id: "all",
            label: "Published",
            count: rows.length,
            depth: 0,
            candidate: true,
            onShow: () => drill(facets[0]?.key ?? ""),
          },
          ...facets.map((def) => ({
            id: def.key,
            label: def.label,
            count: def.count,
            depth: 1 as const,
            candidate: true,
            onShow: () => drill(def.key),
          })),
        ],
      });
    return (
      <ReasonBreakdown
        unit={step.unit}
        processed={step.processed}
        groups={groups}
      />
    );
  };
  const linksOf = (step: RunStepView) => (
    <>
      {step.results ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (step.results) setFamily(step.results);
            scrollTo(DECISIONS_ID);
          }}
        >
          Review these decisions
        </Button>
      ) : null}
      <a
        href={`#${DIAGNOSTICS_ID}`}
        className="inline-flex items-center gap-1 text-link hover:underline"
      >
        <StackIcon aria-hidden className="size-3" />
        Job diagnostics
      </a>
    </>
  );

  return (
    <div className="grid gap-4">
      <RunStepStrip overview={overview} figures={figures} />
      <ReportBlocks
        blocks={runPlanBlocks({
          runId: record.id,
          inputHref: (entity, token) =>
            entityListHref(entity, {
              filters: [{ id: "runStepInput", value: token }],
            }),
          purpose: record.purpose,
          input: steps.data?.input,
          steps: steps.data?.steps ?? [],
        })}
      />
      <RunStepTimeline
        steps={overview.steps}
        breakdownOf={breakdownOf}
        linksOf={linksOf}
      />
    </div>
  );
}

/** The Assessments the Run published in its current family, with evidence. */
export function RunDecisions({ record }: { record: RunOut }) {
  const { decisions, presenter, rows, family, families, setFamily } =
    useRunDetail(record);
  const [facet, setFacet] = useRunFacet(record.id);
  useSectionCount(presenter ? decisions.data?.total : undefined);
  useSectionEmpty(!presenter);
  if (!presenter) return null;
  return (
    <div className="grid gap-2">
      {families.length > 1 ? (
        <Picker
          label="Decision family"
          value={family}
          options={families.map((value) => ({
            value,
            label: humanizeKey(presenterFor(value).noun),
          }))}
          onValueChange={(value) => {
            const next = families.find((candidate) => candidate === value);
            if (next) setFamily(next);
          }}
        />
      ) : null}
      <p className="text-xs/4.5 text-muted-foreground">
        {humanizeKey(presenter.noun)} this Run published. A recommendation
        changes nothing until it is applied.
      </p>
      {decisions.isPending ? (
        <RecordList state={{ status: "pending", rows: 6 }} />
      ) : decisions.isError ? (
        <RecordList
          state={{
            status: "error",
            error: decisions.error,
            title: "Couldn't load decisions",
            onRetry: () => void decisions.refetch(),
          }}
        />
      ) : (
        <DecisionLedger
          key={family}
          runId={record.id}
          poll={live(record.status)}
          rows={rows}
          total={decisions.data.total}
          presenter={presenter}
          facet={facet}
          onFacet={setFacet}
        />
      )}
    </div>
  );
}

/** The Job executing the Run, its pages and raw logs. */
export function RunDiagnostics({ record }: { record: RunOut }) {
  const { jobs } = useRunDetail(record);
  return (
    <div className="grid gap-2">
      <p className="text-xs/4.5 text-muted-foreground">
        The Job executing this Run, its pages and raw logs.
      </p>
      <JobDiagnostics
        jobs={jobs.data}
        state={
          jobs.isError
            ? {
                status: "error",
                error: jobs.error,
                title: "Couldn't load Jobs",
                onRetry: () => void jobs.refetch(),
              }
            : jobs.isPending
              ? { status: "pending", rows: 4 }
              : { status: "success" }
        }
      />
    </div>
  );
}

type RunOut = DetailRecordOf<"run">;
