import type {
  MaintenanceRunSummary,
  MaintenanceStatus,
} from "@cubby/schemas/maintenance";
import { useQuery } from "@tanstack/react-query";
import pluralize from "pluralize";
import type { ReactNode } from "react";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { maintenance } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatInstant } from "~/lib/date-format";
import { formatDuration } from "~/lib/format-duration";
import { cn } from "~/lib/utils";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
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

const runHref = (runId: string) => `/runs/${encodeURIComponent(runId)}`;

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
      <a className="underline" href={runHref(data.runId)}>
        {data.existing
          ? `${data.runId} is already running. View run`
          : `Started ${data.runId}. View run`}
      </a>
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

function ActivePass({ run }: { run: MaintenanceRunSummary }) {
  const step = run.current;
  return (
    <Stack gap="tight" className="rounded-md bg-muted/50 px-3 py-2">
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
        <a className="text-sm underline" href={runHref(run.runId)}>
          View run
        </a>
      </Row>
      {step && step.found > 0 && (
        <>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {(step.done + step.failed + step.skipped).toLocaleString()} of{" "}
            {step.found.toLocaleString()} · {step.left.toLocaleString()} left
            {step.failed > 0 && ` · ${step.failed.toLocaleString()} failed`}
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
    </Stack>
  );
}

function LastPass({ run }: { run: MaintenanceRunSummary }) {
  const duration = run.endedAt
    ? formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
    : null;
  const failed = run.status !== "completed";
  return (
    <Row
      justify="between"
      gap="md"
      wrap
      className="rounded-md bg-muted/50 px-3 py-2"
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
                ? `${run.failedSteps} ${pluralize("step", run.failedSteps)} with failures`
                : (run.failure?.split("\n", 1)[0] ?? run.status)}
            </span>
          )}
        </span>
      </span>
      <a className="text-sm underline" href={runHref(run.runId)}>
        View run
      </a>
    </Row>
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
                {status.backlog[line.key].toLocaleString()}
              </span>
              <span className={cn(line.problem && "text-destructive")}>
                {pluralize(line.noun, status.backlog[line.key])} {line.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Description size="xs">Nothing waiting.</Description>
      )}
      <Stack gap="xs">
        <h3 className="text-sm font-medium">Image processing</h3>
        <p className="text-xs text-muted-foreground">
          Descriptions use the configured AI vision model and stop at the AI
          budget. Transparent images wait for an available Apple companion.
          Originals are retained.
        </p>
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
      </Stack>
    </Stack>
  );
}
