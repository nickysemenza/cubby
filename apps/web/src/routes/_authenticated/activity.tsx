import { type AuditEntityType, auditEntitySchema } from "@cubby/schemas/audit";
import { auditableEntities } from "@cubby/schemas/entity-manifest";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { entities } from "~/entities/entities";

const searchSchema = z.object({
  // The feed's only control — `auditLogListInput` already accepts it, this
  // just exposes it (and keeps a filtered view linkable/refreshable).
  entityType: auditEntitySchema.optional().catch(undefined),
});

const searchDefaults = { entityType: undefined } as const;

export const Route = createFileRoute("/_authenticated/activity")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  // Warm the first page of the audit feed during route load so the list renders
  // hydrated instead of flashing a spinner on mount. Input + getNextPageParam
  // must match AuditLogList's useInfiniteQuery (default limit 20, same entity
  // filter) or the cache won't be reused — hence the `loaderDeps`. prefetch
  // (not ensure) so a cold feed never blocks navigation.
  loaderDeps: ({ search }) => ({ entityType: search.entityType }),
  loader: async ({ context, deps }) => {
    void context.queryClient.prefetchInfiniteQuery(
      context.trpc.auditLog.list.infiniteQueryOptions(
        { limit: 20, entityType: deps.entityType },
        { getNextPageParam: (lastPage) => lastPage.nextCursor },
      ),
    );
  },
  component: ActivityPage,
});

/**
 * Scope filter over the auditable entity set (manifest-derived, so a newly
 * auditable entity appears here automatically). Native select, matching the
 * cookbook scope filter's idiom.
 */
function EntityTypeFilter({
  value,
  onChange,
}: {
  value: AuditEntityType | undefined;
  onChange: (entityType: AuditEntityType | undefined) => void;
}) {
  return (
    <Row as="label" align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Entity</span>
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
        value={value ?? ""}
        onChange={(e) =>
          onChange(
            e.target.value ? (e.target.value as AuditEntityType) : undefined,
          )
        }
      >
        <option value="">All entities</option>
        {auditableEntities.map((entity) => (
          <option key={entity} value={entity}>
            {entities[entity].pluralLabel}
          </option>
        ))}
      </select>
    </Row>
  );
}

function ActivityPage() {
  const { entityType } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Page variant="list" title="Activity">
      <Stack className="max-w-3xl">
        <Row justify="between" align="center" gap="sm" wrap>
          {/* Every auditable entity writes here (products through projects,
              tasks and expenses) — kept generic rather than listing a subset
              that drifts as the manifest grows. */}
          <p className="text-muted-foreground">
            Recent changes across all entities.
          </p>
          <EntityTypeFilter
            value={entityType}
            onChange={(next) => navigate({ search: { entityType: next } })}
          />
        </Row>
        <AuditLogList showEntityLink={true} entityType={entityType} />
      </Stack>
    </Page>
  );
}
