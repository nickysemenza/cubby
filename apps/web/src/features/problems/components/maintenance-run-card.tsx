import type {
  MaintenanceRunSummary,
  MaintenanceStatus,
} from "@cubby/schemas/maintenance";
import { countLabel } from "@cubby/shared/pluralize";
import { useQuery } from "@tanstack/react-query";
import pluralize from "pluralize";
import type { ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { maintenance } from "~/integrations/tanstack-query/generated/catalog/maintenance.gen";
import { formatInstant } from "~/lib/date-format";
import { formatDuration } from "~/lib/format-duration";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Panel, Row, Section, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Progress } from "~/ui/primitives/progress";
import { StaticTable } from "~/ui/primitives/static-table";

/** Poll while a pass runs; an idle card has nothing to watch. */
export const maintenanceRefetchInterval = (
  data: MaintenanceStatus | undefined,
): number | false => (data?.active ? 5_000 : false);

type BacklogKey = Exclude<
  keyof MaintenanceStatus["backlog"],
  "imageProcessing"
>;

const BACKLOG: ReadonlyArray<{
  key: BacklogKey;
  noun: string;
  detail: string;
  /** Terminal outcomes a retry must re-admit, not backlog still draining. */
  problem?: boolean;
}> = [
  {
    key: "staleImageMetadata",
    noun: "image",
    detail: "awaiting EXIF/GPS extraction",
  },
  {
    key: "originalsMissing",
    noun: "original",
    detail: "missing in storage",
    problem: true,
  },
  {
    key: "metadataExtractionFailed",
    noun: "image",
    detail: "whose EXIF/GPS extraction kept failing",
    problem: true,
  },
  {
    key: "staleRecipeTotals",
    noun: "recipe",
    detail: "awaiting cost / nutrition totals",
  },
  {
    key: "unembeddedEntities",
    noun: "record",
    detail: "awaiting a search embedding",
  },
  {
    key: "pendingUploads",
    noun: "upload",
    detail: "abandoned more than a day ago",
  },
];

const IMAGE_STATES = [
  ["current", "Current"],
  ["pending", "Pending"],
  ["waiting", "Waiting for companion"],
  ["skipped", "Skipped"],
  ["failed", "Failed"],
  ["reviewNeeded", "Needs review"],
  ["remaining", "Not processed"],
] as const;

export interface MaintenanceRunOperations {
  status: typeof maintenance.status.queryOptions;
  run: typeof maintenance.run.mutationOptions;
}

const defaultOperations: MaintenanceRunOperations = {
  status: maintenance.status.queryOptions,
  run: maintenance.run.mutationOptions,
};

/** The nightly pass: Run now, the last or running pass, and every backlog it drains. */
export function MaintenanceRunCard({
  operations = defaultOperations,
}: {
  operations?: MaintenanceRunOperations;
}) {
  const status = useQuery({
    ...operations.status(),
    refetchInterval: (query) => maintenanceRefetchInterval(query.state.data),
  });
  const launch = useActionMutation({
    mutationFn: operations.run,
    onSuccess: () => void status.refetch(),
    success: (data) => (
      <span className="inline-flex flex-wrap items-center gap-1">
        {data.existing ? "Already running:" : "Started"}
        <RunLink runId={data.runId} />
      </span>
    ),
  });
  const data = status.data;
  const active = data?.active ?? null;

  let body: ReactNode;
  if (status.isError) {
    body = (
      <ErrorDisplay
        error={status.error}
        title="maintenance status"
        onRetry={() => void status.refetch()}
      />
    );
  } else if (!data) {
    body = <Description size="xs">Checking…</Description>;
  } else {
    body = (
      <Stack gap="md">
        {active ? (
          <ActivePass run={active} />
        ) : data.last ? (
          <LastPass run={data.last} />
        ) : (
          <Description size="xs">No maintenance pass has run yet.</Description>
        )}
        <Backlog status={data} />
      </Stack>
    );
  }

  // The Problems page section supplies the title; this owns the pass line.
  return (
    <Stack gap="md" data-testid="maintenance-run-card">
      <Row align="start" justify="between" gap="md" wrap>
        <Description size="xs">
          {active
            ? `Started ${formatInstant(active.startedAt, "dateShortTime")}${active.trigger === "scheduled" ? " by the nightly schedule" : ""}. One pass at a time.`
            : "Runs nightly. Each pass drains every backlog below and keeps a step-by-step record."}
        </Description>
        <Button
          size="sm"
          variant="outline"
          disabled={Boolean(active) || launch.isPending || !data}
          onClick={() => launch.mutate(undefined)}
        >
          {active ? "Running…" : launch.isPending ? "Starting…" : "Run now"}
        </Button>
      </Row>
      {body}
    </Stack>
  );
}

/** The pass's Run, named and linked like every other record. */
function RunLink({ runId }: { runId: string }) {
  return (
    <EntityRefLink variant="byId" entityKind="run" entityId={runId} compact />
  );
}

function ActivePass({ run }: { run: MaintenanceRunSummary }) {
  const step = run.current;
  return (
    <Panel tone="muted" className="space-y-2 px-3 py-2">
      <Row justify="between" gap="md" wrap>
        <span className="text-sm">
          {step ? (
            <>
              Step {step.position} of {run.steps} ·{" "}
              <span className="font-medium">{step.label}</span>
            </>
          ) : (
            "Finishing…"
          )}
        </span>
        <RunLink runId={run.runId} />
      </Row>
      {step && step.left !== null && step.found > 0 && (
        <>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatCount(step.done + step.failed + step.skipped)} of{" "}
            {formatCount(step.found)} · {formatCount(step.left)} left
            {step.failed > 0 && ` · ${formatCount(step.failed)} failed`}
          </span>
          <Progress
            value={step.done + step.failed + step.skipped}
            max={step.found}
            aria-label={`${step.label} progress`}
          />
        </>
      )}
      {run.status === "paused_auth" && step?.pausedReason && (
        <span className="text-xs text-warning">
          Paused: {step.pausedReason}
          {step.pausedUntil &&
            `. Resumes after ${formatInstant(step.pausedUntil, "dateShortTime")}`}
        </span>
      )}
    </Panel>
  );
}

function LastPass({ run }: { run: MaintenanceRunSummary }) {
  const duration = run.endedAt
    ? formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
    : null;
  const failed = run.status !== "completed";
  return (
    <Panel
      tone="muted"
      className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
    >
      <span className="flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            failed ? "bg-warning" : "bg-positive",
          )}
        />
        <span>
          Last run{" "}
          <span className="font-medium">
            {formatInstant(run.startedAt, "dateShortTime")}
          </span>
          {duration && ` · ${duration}`}
          {failed && (
            <span className="text-warning">
              {" · "}
              {run.failedSteps > 0
                ? `${countLabel(run.failedSteps, "step", { formatted: true })} with failures`
                : (run.failure?.split("\n", 1)[0] ?? run.status)}
            </span>
          )}
        </span>
      </span>
      <RunLink runId={run.runId} />
    </Panel>
  );
}

function Backlog({ status }: { status: MaintenanceStatus }) {
  const lines = BACKLOG.filter((line) => status.backlog[line.key] > 0);
  const images = status.backlog.imageProcessing;
  return (
    <Stack gap="sm">
      {lines.length ? (
        <ul className="flex flex-col gap-1">
          {lines.map((line) => (
            <li key={line.key} className="flex items-baseline gap-2 text-sm">
              <span className="min-w-12 text-right font-mono tabular-nums">
                {formatCount(status.backlog[line.key])}
              </span>
              <span className={cn(line.problem && "text-destructive")}>
                {pluralize(line.noun, status.backlog[line.key])} {line.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState size="inline">Nothing waiting.</EmptyState>
      )}
      <Section
        headingAs="h3"
        title="Image processing"
        caption={
          <>
            Descriptions use the configured AI vision model and stop at the AI
            budget. Transparent images wait for an available Apple companion.
            Originals are retained.
          </>
        }
      >
        <StaticTable
          rows={IMAGE_STATES}
          rowKey={([key]) => key}
          columns={[
            { id: "state", header: "State", cell: ([, label]) => label },
            {
              id: "description",
              header: "Description",
              cell: ([key]) => images.description[key],
            },
            {
              id: "cutout",
              header: "Background removal",
              cell: ([key]) => images.cutout[key],
            },
          ]}
        />
      </Section>
    </Stack>
  );
}
