import { auditEntitySchema } from "@cubby/schemas/audit";
import { auditChannelSchema } from "@cubby/schemas/context";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ActivityChanges } from "~/app/activity/activity-changes";
import { listChromePage } from "~/entity/routing/entity-routes";
import { auditLogListOptions } from "~/lib/audit-log-list";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  entityKind: auditEntitySchema.optional().catch(undefined),
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
    entityKind: search.entityKind,
    channel: search.channel,
  }),
  loader: async ({ context, deps }) => {
    void context.queryClient.prefetchInfiniteQuery(
      auditLogListOptions(
        { limit: 20, entityKind: deps.entityKind, channel: deps.channel },
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
  );
}
