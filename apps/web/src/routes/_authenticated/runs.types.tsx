import {
  RUN_KINDS,
  runPurpose,
  type RunKindDeclaration,
  type RunPurpose,
} from "@cubby/schemas/run-fields";
import { RobotIcon } from "@phosphor-icons/react/dist/csr/Robot";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { z } from "zod";

import type { runCatalogActivityEntry } from "~/contracts/run.contract";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { Page } from "~/entity/page/page";
import { run } from "~/integrations/tanstack-query/generated/catalog/run.gen";
import { formatDuration } from "~/lib/format-duration";
import { pageTitle } from "~/lib/page-title";
import { DateDisplay } from "~/ui/common/date-display";
import { Facts } from "~/ui/common/facts";
import {
  RecordList,
  RecordRow,
  recordColumnsOf,
} from "~/ui/common/record-list";
import { IndexedSections } from "~/ui/data-table/indexed-sections";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { EnumPill } from "~/ui/primitives/enum-pill";

export const Route = createFileRoute("/_authenticated/runs/types")({
  component: RunTypesPage,
  head: () => ({ meta: [{ title: pageTitle("Run types") }] }),
});

const triggerLabels = {
  member: "Member",
  scheduled: "Schedule",
  agent: "Agent",
  system: "System",
} satisfies Record<RunKindDeclaration["trigger"], string>;

const progressDescriptions = {
  targets: "Target records and their outcomes",
  calls: "AI calls",
  operations: "Recorded operations",
  checkpoint: "Execution checkpoints",
  records: "Imported records",
  steps: "The ordered RunStep ledger",
} satisfies Record<RunKindDeclaration["progress"], string>;

const executionDescriptions = {
  steps: "run.execute drives the RunStep ledger",
  ai_work: "run.execute drives AI evaluations",
  mail_discovery: "run.execute drives mailbox discovery",
} satisfies Record<NonNullable<RunKindDeclaration["execution"]>, string>;

const statusOptions = fieldEnumOptions("run", "status");
type ActivityEntry = z.infer<typeof runCatalogActivityEntry>;

function RunActivity({ entry }: { entry: ActivityEntry | undefined }) {
  if (!entry)
    return <p className="text-sm text-muted-foreground">No recorded run.</p>;
  const status = statusOptions.find((option) => option.value === entry.status);
  return (
    <Stack gap="xs">
      <Row align="center" wrap gap="sm">
        <EntityRefLink
          variant="audit"
          entityKind="run"
          entityId={entry.shortcode}
          displayImage={null}
        />
        <EnumPill
          optionRole={status?.role}
          color={status?.color}
          glyph={status?.glyph}
        >
          {status?.label ?? entry.status}
        </EnumPill>
      </Row>
      <p className="text-xs">
        Started <DateDisplay timestamp={entry.startedAt} />
      </p>
      {entry.endedAt && (
        <p className="text-xs text-muted-foreground">
          Ended <DateDisplay timestamp={entry.endedAt} />
          {" · "}
          {Date.parse(entry.endedAt) >= Date.parse(entry.startedAt)
            ? formatDuration(
                Date.parse(entry.endedAt) - Date.parse(entry.startedAt),
              )
            : "Duration unavailable: end precedes start"}
        </p>
      )}
    </Stack>
  );
}

function RunTypeDetails({
  purpose,
  kind,
  latest,
  completed,
  activityReady,
}: {
  purpose: RunPurpose;
  kind: RunKindDeclaration;
  latest: ActivityEntry | undefined;
  completed: ActivityEntry | undefined;
  activityReady: boolean;
}) {
  const steps = kind.steps?.map((step, index) => ({
    key: step.key,
    number: index + 1,
    label: step.label,
    purpose: step.purpose,
    facts: [
      { label: "Action", value: step.action },
      {
        label: "Input",
        value: `${step.input.mode}${step.input.mode === "tally" ? ` (${step.input.reason})` : ""}`,
        className: "font-mono",
      },
      { label: "Unit", value: step.unit },
      { label: "Family", value: step.family, className: "font-mono break-all" },
      {
        label: "Produces Suggestions",
        value: step.results?.family,
        className: "font-mono break-all",
      },
    ].filter((fact) => fact.value !== undefined),
  }));
  return (
    <Stack gap="lg">
      <Facts
        layout="list"
        facts={[
          { label: "Purpose key", value: purpose, className: "font-mono" },
          {
            label: "Started by",
            value: triggerLabels[kind.trigger],
            caption: <code>{kind.trigger}</code>,
          },
          {
            label: "Execution",
            value: kind.execution
              ? executionDescriptions[kind.execution]
              : "Domain-owned execution; no run.execute driver declared",
          },
          {
            label: "Progress",
            value: progressDescriptions[kind.progress],
            caption: <code>{kind.progress}</code>,
          },
          {
            label: "AI evaluations",
            value:
              kind.aiWork === "owned"
                ? "Owned directly by this Run"
                : kind.aiWork === "requested"
                  ? "Requested by reference"
                  : "No evaluation ownership declared",
          },
          {
            label: "Lifecycle",
            value: kind.historical
              ? "No longer created; retained runs remain readable"
              : "Current type",
            caption: kind.routine
              ? "Routine: hidden from the default Runs list"
              : undefined,
          },
          {
            label: "Latest run",
            value: activityReady ? (
              <RunActivity entry={latest} />
            ) : (
              "Recent activity has not loaded."
            ),
          },
          {
            label: "Latest completed",
            value: activityReady ? (
              <RunActivity entry={completed} />
            ) : (
              "Recent activity has not loaded."
            ),
          },
        ]}
      />
      <Stack gap="sm">
        <h3 className="text-sm font-semibold">
          {kind.steps ? `Steps · ${kind.steps.length}` : "Steps"}
        </h3>
        {steps ? (
          <RecordList
            columns={recordColumnsOf(steps)}
            aria-label={`${kind.label} steps`}
          >
            {steps.map((step) => (
              <RecordRow
                key={step.key}
                leading={
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {step.number}.
                  </span>
                }
                primary={
                  <Stack gap="tight">
                    <span className="font-medium">{step.label}</span>
                    <code className="text-xs break-all text-muted-foreground">
                      {step.key}
                    </code>
                  </Stack>
                }
                secondary={step.purpose}
                clip={false}
                facts={step.facts}
              />
            ))}
          </RecordList>
        ) : (
          <p className="text-sm text-muted-foreground">
            No fixed RunStep sequence is declared. Open a recorded run to
            inspect its actual work, outcomes and diagnostics.
          </p>
        )}
      </Stack>
    </Stack>
  );
}

function RunTypesPage() {
  const activity = useQuery(run.catalogActivity.queryOptions(null));
  const groups = [
    { id: "detail-group-current", title: "Current types", historical: false },
    {
      id: "detail-group-historical",
      title: "No longer created",
      historical: true,
    },
  ].map((group) => ({
    id: group.id,
    title: group.title,
    sections: runPurpose.options.flatMap((purpose) => {
      const kind: RunKindDeclaration = RUN_KINDS[purpose];
      if (Boolean(kind.historical) !== group.historical) return [];
      return [
        {
          id: purpose,
          title: kind.label,
          description: kind.description,
          icon: RobotIcon,
          headerAction: (
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/runs" search={{ purpose }} />}
              nativeButton={false}
            >
              View runs
            </Button>
          ),
          content: (
            <RunTypeDetails
              purpose={purpose}
              kind={kind}
              latest={activity.data?.latest.find(
                (entry) => entry.purpose === purpose,
              )}
              completed={activity.data?.completed.find(
                (entry) => entry.purpose === purpose,
              )}
              activityReady={activity.data !== undefined}
            />
          ),
        },
      ];
    }),
  }));
  return (
    <Page
      variant="list"
      title="Run types"
      actions={
        <Row gap="sm">
          <Button
            variant="outline"
            disabled={activity.isFetching}
            onClick={() => void activity.refetch()}
          >
            Refresh activity
          </Button>
          <Button
            variant="outline"
            render={<Link to="/runs" />}
            nativeButton={false}
          >
            Back to Runs
          </Button>
        </Row>
      }
    >
      <p className="max-w-prose text-sm text-muted-foreground">
        How Cubby runs imports, AI work and household upkeep. Explore each
        type’s execution, progress and declared steps, then open its history.
        Activity includes routine and ephemeral runs hidden from the default
        list.
      </p>
      {activity.isPending && (
        <output className="text-sm text-muted-foreground">
          Loading recent run activity…
        </output>
      )}
      {activity.error && (
        <ErrorDisplay
          title="recent run activity"
          error={activity.error}
          onRetry={() => void activity.refetch()}
        />
      )}
      <IndexedSections groups={groups} />
    </Page>
  );
}
