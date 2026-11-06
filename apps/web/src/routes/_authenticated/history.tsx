import { auditEntitySchema } from "@cubby/schemas/audit";
import { auditChannelSchema } from "@cubby/schemas/context";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { EmbeddedEntityList } from "~/entity/entity-list/generic-entity-list";
import { Page } from "~/entity/page/page";
import { ActivityChanges } from "~/features/activity/activity-changes";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { auditLog } from "~/integrations/tanstack-query/generated/domains/auditLog.gen";
import { pageTitle } from "~/lib/page-title";
import { Section, Stack } from "~/ui/layout";

const searchSchema = z.object({
  entityKind: auditEntitySchema.optional().catch(undefined),
  channel: auditChannelSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/history")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    void context.queryClient.prefetchInfiniteQuery(
      cursorQueryOptions(auditLog.list, {
        limit: 20,
        entityKind: deps.entityKind,
        channel: deps.channel,
      }),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("History") }] }),
  component: HistoryPage,
});

function HistoryPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <Page variant="list" title="History" layout="full" bodyGutter="standard">
      <Stack gap="lg">
        <Section
          headingAs="h2"
          title="Run history"
          caption="Recorded executions, including routine work. Open a Run for its actual outcomes."
        >
          <EmbeddedEntityList
            entity="run"
            pageSize={15}
            columns={["id", "purpose", "status", "startedAt", "endedAt"]}
            allLink
          />
        </Section>
        <Section headingAs="h2" title="Changes">
          <ActivityChanges
            entityKind={search.entityKind}
            channel={search.channel}
            onEntityKindChange={(entityKind) =>
              navigate({
                search: (previous) => ({ ...previous, entityKind }),
              })
            }
            onChannelChange={(channel) =>
              navigate({ search: (previous) => ({ ...previous, channel }) })
            }
            onClear={() =>
              navigate({
                search: { entityKind: undefined, channel: undefined },
              })
            }
          />
        </Section>
      </Stack>
    </Page>
  );
}
