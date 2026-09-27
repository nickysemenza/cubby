import { auditEntitySchema } from "@cubby/schemas/audit";
import { auditChannelSchema } from "@cubby/schemas/context";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { listChromePage } from "~/app/_components/routing/entity-routes";
import { ActivityChanges } from "~/app/activity/activity-changes";
import { auditLogListOptions } from "~/lib/audit-log.functions";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  entityType: auditEntitySchema.optional().catch(undefined),
  channel: auditChannelSchema.optional().catch(undefined),
});

const ActivityPage = listChromePage({
  title: "Activity",
  page: ActivityBody,
  bodyGutter: () => "standard",
});

export const Route = createFileRoute("/_authenticated/activity")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
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
  const navigate = Route.useNavigate();
  return (
    <ActivityChanges
      entityType={search.entityType}
      channel={search.channel}
      onEntityTypeChange={(entityType) =>
        navigate({ search: (previous) => ({ ...previous, entityType }) })
      }
      onChannelChange={(channel) =>
        navigate({ search: (previous) => ({ ...previous, channel }) })
      }
      onClear={() =>
        navigate({
          search: (previous) => ({
            ...previous,
            entityType: undefined,
            channel: undefined,
          }),
        })
      }
    />
  );
}
