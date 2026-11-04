import { auditEntitySchema } from "@cubby/schemas/audit";
import { auditChannelSchema } from "@cubby/schemas/context";
import { runShortcode } from "@cubby/schemas/identifiers";
import { jobLane, jobState, jobWaitingOnReason } from "@cubby/schemas/job";
import { RUN_KINDS } from "@cubby/schemas/run-fields";
import { workFamily, workQueueInput } from "@cubby/schemas/work-queue";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { EmbeddedEntityList } from "~/entity/entity-list/generic-entity-list";
import { Page } from "~/entity/page/page";
import { ActivityChanges } from "~/features/activity/activity-changes";
import { QueueOverview } from "~/features/activity/queue-overview";
import { MaintenanceRunCard } from "~/features/maintenance/maintenance-run-card";
import { MaintenanceTools } from "~/features/maintenance/maintenance-tools";
import { DefinedRunSteps, WorkEffects } from "~/features/run/work-definition";
import { WorkQueue } from "~/features/work-queue/work-queue-page";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { auditLog } from "~/integrations/tanstack-query/generated/domains/auditLog.gen";
import { pageTitle } from "~/lib/page-title";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Row, Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

const activityTab = z.enum([
  "needs-you",
  "now",
  "improvements",
  "history",
  "maintenance",
]);
const searchSchema = z.object({
  tab: activityTab.optional().catch(undefined),
  entityKind: auditEntitySchema.optional().catch(undefined),
  channel: auditChannelSchema.optional().catch(undefined),
  lane: jobLane.optional().catch(undefined),
  reason: jobWaitingOnReason.optional().catch(undefined),
  state: jobState.optional().catch(undefined),
  kind: z.string().trim().min(1).max(100).optional().catch(undefined),
  runId: runShortcode.optional().catch(undefined),
  attention: z.boolean().optional().catch(undefined),
  page: z.int().nonnegative().optional().catch(undefined),
});
const views = [
  { key: "needs-you", label: "Needs you" },
  { key: "now", label: "Automatic work" },
  { key: "improvements", label: "Improvements" },
  { key: "history", label: "History" },
  { key: "maintenance", label: "Advanced maintenance" },
] as const;
const decisionScope = {
  view: "human",
  family: workFamily.options.filter(
    (family) => !["problem", "suggestion", "research"].includes(family),
  ),
} as const;
const problemScope = { view: "problems" } as const;
const financialProposalScope = workQueueInput
  .pick({ view: true, family: true, reason: true })
  .parse({
    view: "human",
    family: "suggestion",
    reason: ["suggestions:statement_transaction", "suggestions:transfer_pair"],
  });
const optionalProposalScope = workQueueInput
  .pick({ view: true, family: true, reason: true })
  .parse({
    family: "suggestion",
    reason: [
      "suggestions:field",
      "suggestions:recommendation",
      "suggestions:image_description",
    ],
  });
const researchScope = { family: "research" } as const;
const externalScope = { view: "external" } as const;

export const Route = createFileRoute("/_authenticated/activity")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    tab: search.tab,
    entityKind: search.entityKind,
    channel: search.channel,
  }),
  loader: async ({ context, deps }) => {
    if (deps.tab === "history" || deps.entityKind || deps.channel)
      void context.queryClient.prefetchInfiniteQuery(
        cursorQueryOptions(auditLog.list, {
          limit: 20,
          entityKind: deps.entityKind,
          channel: deps.channel,
        }),
      );
  },
  head: () => ({ meta: [{ title: pageTitle("Work") }] }),
  component: () => (
    <Page variant="list" title="Work" layout="full" bodyGutter="standard">
      <ActivityBody />
    </Page>
  ),
});

function ActivityBody() {
  // This route’s handlers may hydrate after the surrounding app shell.
  const hydrated = useHydrated();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // Older diagnostic links supplied filters before Activity had named views.
  const active =
    search.tab ??
    (search.lane ||
    search.reason ||
    search.state ||
    search.kind ||
    search.runId ||
    search.attention
      ? "now"
      : search.entityKind || search.channel
        ? "history"
        : "needs-you");
  const [maintenanceVisited, setMaintenanceVisited] = useState(
    active === "maintenance",
  );
  useEffect(() => {
    if (active === "maintenance") setMaintenanceVisited(true);
  }, [active]);
  return (
    <Stack gap="lg">
      <Row gap="md" wrap>
        <Link to="/runs/types" className="text-link hover:underline">
          What does each Run do?
        </Link>
        <Link to="/work-queue" className="text-link hover:underline">
          All work and filters
        </Link>
        <Link to="/runs" className="text-link hover:underline">
          Runs
        </Link>
        <Link to="/jobs" className="text-link hover:underline">
          Jobs
        </Link>
      </Row>
      <Tabs
        value={active}
        onValueChange={(value) => {
          const tab = activityTab.safeParse(value);
          if (tab.success)
            void navigate({
              search: (previous) => ({ ...previous, tab: tab.data }),
              hash: "",
            });
        }}
      >
        <TabsList
          variant="line"
          className="max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto"
          aria-label="Work views"
        >
          {views.map((view) => (
            <TabsTrigger
              key={view.key}
              value={view.key}
              className="flex-none"
              disabled={!hydrated}
            >
              {view.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {views.map((view) => (
          <TabsContent
            key={view.key}
            value={view.key}
            keepMounted={view.key === "maintenance"}
          >
            {active === view.key ||
            (view.key === "maintenance" && maintenanceVisited) ? (
              <div className="pt-3">
                {view.key === "needs-you" ? (
                  <Stack gap="lg">
                    <p className="max-w-prose text-sm text-muted-foreground">
                      Decisions and concrete blockers needing your intervention.
                      Optional enrichment stays in Improvements; retries and
                      waits stay in Automatic work.
                    </p>
                    <Section headingAs="h2" title="Decisions">
                      <WorkQueue scope={decisionScope} label="Decisions" />
                    </Section>
                    <Section headingAs="h2" title="Financial proposals">
                      <WorkQueue
                        scope={financialProposalScope}
                        label="Financial proposals"
                      />
                    </Section>
                    <Section headingAs="h2" title="Problems">
                      <WorkQueue
                        scope={problemScope}
                        groupBy="reason"
                        label="Problems"
                      />
                    </Section>
                    <QueueOverview
                      mode="attention"
                      search={{}}
                      onSearchChange={(next) =>
                        void navigate({
                          search: (previous) => ({
                            ...previous,
                            ...next,
                            tab: "now",
                          }),
                        })
                      }
                    />
                  </Stack>
                ) : view.key === "improvements" ? (
                  <Stack gap="lg">
                    <p className="max-w-prose text-sm text-muted-foreground">
                      Optional proposals and missing facts that can improve your
                      records. Review here or continue with an agent; these are
                      not errors.
                    </p>
                    <Row gap="md" wrap>
                      <Link
                        to="/suggestions"
                        className="text-link hover:underline"
                      >
                        Suggestions, automatic decisions and rules
                      </Link>
                    </Row>
                    <Section headingAs="h2" title="Proposals">
                      <WorkQueue
                        scope={optionalProposalScope}
                        label="Proposals"
                      />
                    </Section>
                    <Section headingAs="h2" title="Research and missing facts">
                      <WorkQueue
                        scope={researchScope}
                        groupBy="reason"
                        label="Research and missing facts"
                      />
                    </Section>
                  </Stack>
                ) : view.key === "now" ? (
                  <Stack gap="lg">
                    <QueueOverview
                      search={search}
                      onSearchChange={(next) =>
                        void navigate({
                          search: (previous) => ({
                            ...previous,
                            ...next,
                            tab: "now",
                          }),
                          hash: "queue-jobs",
                          replace: true,
                        })
                      }
                    />
                    <Section
                      headingAs="h2"
                      title="Waiting outside Cubby"
                      caption="Posting windows, paused Runs and other declared waits. Waiting does not mean failed."
                    >
                      <WorkQueue scope={externalScope} label="External waits" />
                    </Section>
                  </Stack>
                ) : view.key === "history" ? (
                  <Stack gap="lg">
                    <Section
                      headingAs="h2"
                      title="Run history"
                      caption="Recorded executions, including routine work. Open a Run for its actual outcomes."
                    >
                      <EmbeddedEntityList
                        entity="run"
                        pageSize={15}
                        columns={[
                          "id",
                          "purpose",
                          "status",
                          "startedAt",
                          "endedAt",
                        ]}
                        allLink
                      />
                    </Section>
                    <Section headingAs="h2" title="Changes">
                      <ActivityChanges
                        entityKind={search.entityKind}
                        channel={search.channel}
                        onEntityKindChange={(entityKind) =>
                          navigate({
                            search: (previous) => ({
                              ...previous,
                              entityKind,
                              tab: "history",
                            }),
                          })
                        }
                        onChannelChange={(channel) =>
                          navigate({
                            search: (previous) => ({
                              ...previous,
                              channel,
                              tab: "history",
                            }),
                          })
                        }
                        onClear={() =>
                          navigate({
                            search: (previous) => ({
                              ...previous,
                              entityKind: undefined,
                              channel: undefined,
                            }),
                          })
                        }
                      />
                    </Section>
                  </Stack>
                ) : (
                  <Stack gap="lg">
                    <Section
                      headingAs="h2"
                      title="Daily maintenance"
                      caption="Daily at 7 a.m. America/Los_Angeles, following daylight saving time. Each step is recorded in a Run."
                    >
                      <Stack gap="md">
                        <WorkEffects
                          explanation={RUN_KINDS.maintenance.explanation}
                        />
                        <Disclosure summary="The maintenance pass, step by step">
                          <DefinedRunSteps kind={RUN_KINDS.maintenance} />
                        </Disclosure>
                        <MaintenanceRunCard
                          visible={active === "maintenance"}
                        />
                      </Stack>
                    </Section>
                    <Section
                      headingAs="h2"
                      title="Repair tools"
                      caption="Occasional repairs. Each command owns its scope and effects; previews inspect current candidates."
                    >
                      <MaintenanceTools active={active === "maintenance"} />
                    </Section>
                  </Stack>
                )}
              </div>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </Stack>
  );
}
