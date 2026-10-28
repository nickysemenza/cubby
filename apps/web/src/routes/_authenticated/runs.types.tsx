import { JOB_KIND_POLICY } from "@cubby/schemas/job";
import {
  RUN_KINDS,
  runPurpose,
  type RunKindDeclaration,
  type RunPurpose,
} from "@cubby/schemas/run-fields";
import { RobotIcon } from "@phosphor-icons/react/dist/csr/Robot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import type { z } from "zod";

import type { runCatalogActivityEntry } from "~/contracts/run.contract";
import { EntityAuditLink } from "~/entity/components/entity-ref-link";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { useEntityMetadata } from "~/entity/metadata";
import { Page } from "~/entity/page/page";
import {
  DefinedRunSteps,
  JobDefinition,
  WorkEffects,
} from "~/features/run/work-definition";
import { run } from "~/integrations/tanstack-query/generated/catalog/run.gen";
import { formatDuration } from "~/lib/format-duration";
import { pageTitle } from "~/lib/page-title";
import { DateDisplay } from "~/ui/common/date-display";
import { Facts } from "~/ui/common/facts";
import {
  type IndexedSectionGroup,
  IndexedSections,
} from "~/ui/data-table/indexed-sections";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
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

type ActivityEntry = z.infer<typeof runCatalogActivityEntry>;

function RunActivity({ entry }: { entry: ActivityEntry | undefined }) {
  const queryClient = useQueryClient();
  useEntityMetadata("run");
  const statusOptions = useMemo(
    () => fieldEnumOptions(queryClient, "run", "status"),
    [queryClient],
  );
  if (!entry)
    return <p className="text-sm text-muted-foreground">No recorded run.</p>;
  const status = statusOptions.find((option) => option.value === entry.status);
  return (
    <Stack gap="xs">
      <Row align="center" wrap gap="sm">
        <EntityAuditLink
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
  return (
    <Stack gap="lg">
      <WorkEffects explanation={kind.explanation} />
      <Facts
        layout="list"
        facts={[
          { label: "Started by", value: triggerLabels[kind.trigger] },
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
          {
            label: "Lifecycle",
            value: kind.historical
              ? "No longer created; retained Runs remain readable"
              : kind.routine
                ? "Routine; shown in this reference and execution history"
                : "Current type",
          },
        ]}
      />
      <Stack gap="sm">
        <h3 className="text-sm font-semibold">
          {kind.steps
            ? `Defined steps · ${kind.steps.length}`
            : "How execution varies"}
        </h3>
        <DefinedRunSteps kind={kind} />
      </Stack>
      <Disclosure summary="Technical details">
        <Facts
          layout="list"
          facts={[
            { label: "Type", value: purpose },
            {
              label: "Execution",
              value: kind.execution
                ? executionDescriptions[kind.execution]
                : "Domain-owned execution",
            },
            {
              label: "Progress source",
              value: progressDescriptions[kind.progress],
            },
            { label: "AI ownership", value: kind.aiWork ?? "Domain-owned" },
          ]}
        />
      </Disclosure>
    </Stack>
  );
}

function RunTypesPage() {
  const activity = useQuery(run.catalogActivity.queryOptions(null));
  const groups: IndexedSectionGroup[] = [
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
  groups.push({
    id: "detail-group-jobs",
    title: "Job types",
    sections: Object.entries(JOB_KIND_POLICY).map(([key, definition]) => ({
      id: `job-${key}`,
      title: definition.label,
      description: definition.purpose,
      icon: RobotIcon,
      headerAction: (
        <Button
          variant="outline"
          size="sm"
          render={
            <Link
              to="/jobs"
              search={{
                kind: key,
                includeInternal: definition.internal ? "true" : undefined,
              }}
            />
          }
          nativeButton={false}
        >
          View Jobs
        </Button>
      ),
      content: <JobDefinition kind={key} defaultOpen />,
    })),
  });
  return (
    <Page
      variant="list"
      title="What does each Run do?"
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
        What each Run and Job targets, what it can change, and what happens if
        it cannot finish. These are definitions, not live progress. Open a
        recorded Run or Job for actual outcomes.
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
