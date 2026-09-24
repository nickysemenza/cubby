import { activityKind, activityRunId } from "@cubby/schemas/activity";
import { auditEntitySchema } from "@cubby/schemas/audit";
import { auditChannelSchema } from "@cubby/schemas/context";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";

import { listChromePage } from "~/app/_components/routing/entity-routes";
import { ActivityChanges } from "~/app/activity/activity-changes";
import { ActivityRunDetail } from "~/app/activity/activity-run-detail";
import { ActivityRuns } from "~/app/activity/activity-runs";
import { PurchaseImportAgentConnection } from "~/app/activity/purchase-import-agent-connection";
import { Button } from "~/components/ui/button";
import { StatusText } from "~/components/ui/status-text";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { entities } from "~/entities/entities";
import { activity } from "~/lib/activity.functions";
import { auditLogListOptions } from "~/lib/audit-log.functions";
import { pageTitle } from "~/lib/page-title";
import { purchaseAgentConnectionStatus } from "~/lib/purchase-import-run-detail";

const searchSchema = z.object({
  tab: z.enum(["runs", "changes", "connections"]).optional().catch(undefined),
  agent: purchaseAgentConnectionStatus.optional().catch(undefined),
  purchaseAgent: purchaseAgentConnectionStatus.optional().catch(undefined),
  view: z.enum(["runs", "changes", "connections"]).optional().catch(undefined),
  kind: activityKind.optional().catch(undefined),
  executor: z
    .enum(["all", "cloud", "device", "unknown"])
    .optional()
    .catch(undefined),
  selectedRun: activityRunId.optional().catch(undefined),
  state: z.string().max(50).optional().catch(undefined),
  subjectId: z.string().max(100).optional().catch(undefined),
  submissionId: z
    .string()
    .regex(/^IPS-[A-Z0-9]+$/u)
    .optional()
    .catch(undefined),
  from: z.iso.datetime().optional().catch(undefined),
  to: z.iso.datetime().optional().catch(undefined),
  sort: z.enum(["newest", "oldest"]).optional().catch(undefined),
  deviceId: z.uuid().optional().catch(undefined),
  // The feed's only controls — `auditLogListInput` already accepts both,
  // this just exposes them (and keeps a filtered view linkable/refreshable).
  entityType: auditEntitySchema.optional().catch(undefined),
  channel: auditChannelSchema.optional().catch(undefined),
});

const searchDefaults = {
  view: undefined,
  kind: undefined,
  executor: undefined,
  selectedRun: undefined,
  state: undefined,
  subjectId: undefined,
  submissionId: undefined,
  from: undefined,
  to: undefined,
  sort: undefined,
  deviceId: undefined,
  entityType: undefined,
  channel: undefined,
} as const;

// Bound to a const, not inlined into the options object below: see
// `entity-routes.tsx`'s doc comment on why the splitter needs a literal
// identifier here, not an inline factory call. Must be defined (and
// initialized) before `Route` reads it below — `const` isn't hoisted the way
// `function ActivityBody` is.
const ActivityPage = listChromePage({
  title: "Activity",
  page: ActivityBody,
});

export const Route = createFileRoute("/_authenticated/activity")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  // Warm the first page of the audit feed during route load so the list renders
  // hydrated instead of flashing a spinner on mount. Input + getNextPageParam
  // must match AuditLogList's useInfiniteQuery (default limit 20, same entity
  // filter) or the cache won't be reused — hence the `loaderDeps`. prefetch
  // (not ensure) so a cold feed never blocks navigation.
  loaderDeps: ({ search }) => ({
    view: search.view,
    kind: search.kind,
    executor: search.executor,
    entityType: search.entityType,
    channel: search.channel,
  }),
  loader: async ({ context, deps }) => {
    void context.queryClient.prefetchInfiniteQuery(
      auditLogListOptions(
        { limit: 20, entityType: deps.entityType, channel: deps.channel },
        { getNextPageParam: (lastPage) => lastPage.nextCursor },
      ),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("Activity") }] }),
  component: ActivityPage,
});

function ActivityBody() {
  const search = Route.useSearch();
  const {
    deviceId,
    entityType,
    executor = "all",
    from,
    kind,
    selectedRun,
    channel,
    state,
    subjectId,
    submissionId,
    to,
  } = search;
  const sort = search.sort ?? "newest";
  const view =
    search.tab ?? search.view ?? (entityType || channel ? "changes" : "runs");
  const navigate = useNavigate({ from: Route.fullPath });
  const submission = useQuery({
    ...activity.submission.queryOptions({ id: submissionId ?? "IPS-000000" }),
    enabled: submissionId !== undefined,
    refetchInterval: (query) => (query.state.data?.remaining ? 15_000 : false),
    refetchIntervalInBackground: false,
  });

  return (
    <Tabs
      value={view}
      onValueChange={(next) =>
        navigate({
          search: (prev) => ({
            ...prev,
            tab: z.enum(["runs", "changes", "connections"]).parse(next),
            view: undefined,
          }),
        })
      }
    >
      <TabsList variant="line" aria-label="Activity views">
        <TabsTrigger value="runs">Runs</TabsTrigger>
        <TabsTrigger value="changes">Changes</TabsTrigger>
        <TabsTrigger value="connections">Connections</TabsTrigger>
      </TabsList>
      <TabsContent value="runs">
        <ActivityRuns
          kind={kind}
          state={state}
          subjectId={subjectId}
          submissionId={submissionId}
          from={from}
          to={to}
          sort={sort}
          deviceId={deviceId}
          executor={executor}
          onKindChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, kind: next }) })
          }
          onStateChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, state: next }) })
          }
          onSubjectIdChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, subjectId: next }) })
          }
          onSubmissionIdChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, submissionId: next }) })
          }
          onFromChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, from: next }) })
          }
          onToChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, to: next }) })
          }
          onSortChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, sort: next }) })
          }
          onDeviceIdChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, deviceId: next }) })
          }
          onExecutorChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, executor: next }) })
          }
          onSelect={(id) =>
            navigate({ search: (prev) => ({ ...prev, selectedRun: id }) })
          }
        />
        {submissionId && submission.data ? (
          <StatusText>
            {submission.data.total} jobs · {submission.data.newlyQueued} queued
            · {submission.data.reused} reused · {submission.data.alreadyRunning}{" "}
            already running · {submission.data.completed} completed ·{" "}
            {submission.data.skipped} skipped · {submission.data.failed} failed
            · {submission.data.remaining} remaining · Cost{" "}
            {submission.data.estimatedCost === null
              ? "unavailable"
              : `$${submission.data.estimatedCost.toFixed(4)}`}
          </StatusText>
        ) : null}
        {selectedRun ? (
          <ActivityRunDetail
            id={selectedRun}
            onClose={() =>
              navigate({
                search: (prev) => ({ ...prev, selectedRun: undefined }),
              })
            }
          />
        ) : null}
      </TabsContent>
      <TabsContent value="changes">
        <ActivityChanges
          entityType={entityType}
          channel={channel}
          onEntityTypeChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, entityType: next }) })
          }
          onChannelChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, channel: next }) })
          }
        />
      </TabsContent>
      <TabsContent value="connections">
        <PurchaseImportAgentConnection
          feedback={search.purchaseAgent ?? search.agent}
        />
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={
            <Link
              to={entities.device.routes.list}
              aria-label="Open all devices"
            />
          }
        >
          Devices
          <ArrowUpRightIcon />
        </Button>
      </TabsContent>
    </Tabs>
  );
}
