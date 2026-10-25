import { auditEntitySchema } from "@cubby/schemas/audit";
import { auditChannelSchema } from "@cubby/schemas/context";
import { runShortcode } from "@cubby/schemas/identifiers";
import { jobLane, jobState, jobWaitingOnReason } from "@cubby/schemas/job";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { listChromePage } from "~/entity/routing/list-page";
import { ActivityChanges } from "~/features/activity/activity-changes";
import { QueueOverview } from "~/features/activity/queue-overview";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { auditLog } from "~/integrations/tanstack-query/generated/catalog/auditLog.gen";
import { pageTitle } from "~/lib/page-title";
import { Section } from "~/ui/layout";

const searchSchema = z.object({
  entityKind: auditEntitySchema.optional().catch(undefined),
  channel: auditChannelSchema.optional().catch(undefined),
  // The Job queue filter; each queue count links here with its lane and reason.
  lane: jobLane.optional().catch(undefined),
  reason: jobWaitingOnReason.optional().catch(undefined),
  state: jobState.optional().catch(undefined),
  kind: z.string().trim().min(1).max(100).optional().catch(undefined),
  runId: runShortcode.optional().catch(undefined),
  attention: z.boolean().optional().catch(undefined),
  page: z.int().nonnegative().optional().catch(undefined),
});

const ActivityPage = listChromePage({
  title: "Activity",
  page: ActivityBody,
  bodyGutter: () => "standard",
});

export const Route = createFileRoute("/_authenticated/activity")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    entityKind: search.entityKind,
    channel: search.channel,
  }),
  loader: async ({ context, deps }) => {
    void context.queryClient.prefetchInfiniteQuery(
      cursorQueryOptions(auditLog.list, {
        limit: 20,
        entityKind: deps.entityKind,
        channel: deps.channel,
      }),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("Activity") }] }),
  component: ActivityPage,
});

function ActivityBody() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <>
      <QueueOverview
        search={search}
        onSearchChange={(next) =>
          navigate({
            search: (previous) => ({ ...previous, ...next }),
            hash: "queue-jobs",
            replace: true,
          })
        }
      />
      <Section headingAs="h2" title="Changes" className="mt-6">
        <ActivityChanges
          entityKind={search.entityKind}
          channel={search.channel}
          onEntityKindChange={(entityKind) =>
            navigate({ search: (previous) => ({ ...previous, entityKind }) })
          }
          onChannelChange={(channel) =>
            navigate({ search: (previous) => ({ ...previous, channel }) })
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
    </>
  );
}
